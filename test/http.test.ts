import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { createMcpHonoApp } from '../src/daemon/http.ts';
import { createTestStack, type TestStack } from './helpers.ts';

const stacks: TestStack[] = [];
const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

afterEach(async () => {
  await Promise.all(stacks.splice(0).map((stack) => stack.close()));
});

async function appStack() {
  const stack = await createTestStack();
  stacks.push(stack);
  const daemon = createMcpHonoApp({
    host: '127.0.0.1',
    service: stack.service,
    sessions: stack.sessions,
    turns: stack.turns,
    artifactStore: stack.artifactStore,
    authToken: stack.authToken,
    backends: stack.backends,
    storageReady: true,
    probes: {
      docker: { nodeId: 'local', available: true },
      firecracker: { nodeId: 'local', available: false, reason: 'test environment' },
    },
  });
  return { stack, ...daemon };
}

function modernRequest(method: string, params: Record<string, unknown>, name?: string, version = '2026-07-28'): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'MCP-Protocol-Version': version,
    'Mcp-Method': method,
    Host: '127.0.0.1',
    Authorization: 'Bearer test-token',
    'Electrosphere-Thread-Id': 'test-thread',
    'Electrosphere-Turn-Id': 'test-turn',
  };
  if (name) headers['Mcp-Name'] = name;
  return new Request('http://127.0.0.1/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method,
      params: { ...params, _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': version } },
    }),
  });
}

function legacyRequest(method: string, params: Record<string, unknown>): Request {
  return new Request('http://127.0.0.1/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'MCP-Protocol-Version': '2025-11-25',
      Host: '127.0.0.1',
      Authorization: 'Bearer test-token',
      'Electrosphere-Thread-Id': 'test-thread',
      'Electrosphere-Turn-Id': 'test-turn',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

async function legacyJson(response: Response): Promise<unknown> {
  const body = await response.text();
  if (response.headers.get('content-type')?.includes('application/json')) return JSON.parse(body);
  const data = body.split(/\r?\n/).find((line) => line.startsWith('data: '));
  if (!data) throw new Error('Legacy MCP response did not contain an SSE data event');
  return JSON.parse(data.slice('data: '.length));
}

describe('daemon HTTP surface', () => {
  test('serves health and removes legacy workspace and instant routes', async () => {
    const { app } = await appStack();
    const health = await app.request('/healthz', { headers: { Host: '127.0.0.1' } });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ sqlite: { ready: true }, backends: { docker: { available: true } } });

    expect((await app.request('/v1/workspaces', {
      method: 'POST',
      headers: { Host: '127.0.0.1', 'content-type': 'application/json' },
      body: '{}',
    })).status).toBe(404);
    expect((await app.request('/v1/instants', {
      method: 'POST',
      headers: { Host: '127.0.0.1', 'content-type': 'application/json' },
      body: '{}',
    })).status).toBe(404);
  });


  test('requires bearer auth and an open bound turn for tool calls', async () => {
    const { app, stack } = await appStack();
    const missing = modernRequest('tools/list', {});
    missing.headers.delete('Authorization');
    expect((await app.fetch(missing)).status).toBe(401);

    const wrong = modernRequest('tools/list', {});
    wrong.headers.set('Authorization', 'Bearer wrong-token');
    expect((await app.fetch(wrong)).status).toBe(403);

    const noHeaders = modernRequest('tools/call', { name: 'shell', arguments: { action: 'exec', command: 'printf blocked' } }, 'shell');
    noHeaders.headers.delete('Electrosphere-Thread-Id');
    noHeaders.headers.delete('Electrosphere-Turn-Id');
    expect(await (await app.fetch(noHeaders)).json()).toMatchObject({ error: { data: { code: 'INVALID_ARGUMENT' } } });

    const closed = await app.fetch(modernRequest('tools/call', {
      name: 'shell',
      arguments: { action: 'exec', command: 'printf blocked' },
    }, 'shell'));
    expect(closed.status).toBe(400);
    expect(await closed.json()).toMatchObject({ error: { data: { code: 'TURN_CLOSED' } } });

    await stack.turns.start({ threadId: 'test-thread', turnId: 'test-turn', mode: 'instant' });
    await stack.turns.finish({ threadId: 'test-thread', turnId: 'test-turn' });
    const finished = await app.fetch(modernRequest('tools/call', { name: 'read', arguments: { path: '.' } }, 'read'));
    expect(await finished.json()).toMatchObject({ error: { data: { code: 'TURN_CLOSED' } } });
  });

  test('starts and finishes an authenticated harness turn', async () => {
    const { app } = await appStack();
    const started = await app.request('/v1/harness/threads/harness-thread/turns/harness-turn', {
      method: 'POST',
      headers: { Host: '127.0.0.1', Authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'instant' }),
    });
    expect(started.status).toBe(201);
    expect(await started.json()).toMatchObject({ threadId: 'harness-thread', turnId: 'harness-turn', mode: 'instant', state: 'OPEN' });

    const finished = await app.request('/v1/harness/threads/harness-thread/turns/harness-turn/finish', {
      method: 'POST',
      headers: { Host: '127.0.0.1', Authorization: 'Bearer test-token' },
    });
    expect(finished.status).toBe(200);
    expect(await finished.json()).toMatchObject({ state: 'FINISHED' });
  });
  test('keeps one fresh backend-selected runtime per instant turn', async () => {
    const { app, stack } = await appStack();
    const dockerStart = await app.request('/v1/harness/threads/instant-docker/turns/turn-1', {
      method: 'POST',
      headers: { Host: '127.0.0.1', Authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'instant', backend: 'docker' }),
    });
    expect(dockerStart.status).toBe(201);
    const dockerTurn = await dockerStart.json() as { instanceId: string };
    expect(stack.repository.getInstance(dockerTurn.instanceId)?.backend).toBe('docker');
    const firstDockerHandle = stack.service.getTurnHandle(dockerTurn.instanceId);
    await stack.backends.get(firstDockerHandle.instance.backend).fileWrite(firstDockerHandle.handle, {
      path: 'docker-ephemeral.txt',
      source: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from('ephemeral')); controller.close(); } }),
      createParents: false,
    });
    await stack.turns.finish({ threadId: 'instant-docker', turnId: 'turn-1' });
    const dockerStart2 = await app.request('/v1/harness/threads/instant-docker/turns/turn-2', {
      method: 'POST',
      headers: { Host: '127.0.0.1', Authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'instant', backend: 'docker' }),
    });
    const dockerTurn2 = await dockerStart2.json() as { instanceId: string };
    expect(dockerTurn2.instanceId).not.toBe(dockerTurn.instanceId);
    const secondDockerHandle = stack.service.getTurnHandle(dockerTurn2.instanceId);
    await expect(stack.backends.get(secondDockerHandle.instance.backend).fileRead(secondDockerHandle.handle, { path: 'docker-ephemeral.txt' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(stack.repository.getThreadWorkspace('instant-docker')).toBeUndefined();
    await stack.turns.finish({ threadId: 'instant-docker', turnId: 'turn-2' });

    const start = async (turnId: string) => {
      const response = await app.request(`/v1/harness/threads/instant-http/turns/${turnId}`, {
        method: 'POST',
        headers: { Host: '127.0.0.1', Authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'instant' }),
      });
      expect(response.status).toBe(201);
      return response.json() as Promise<{ instanceId: string }>;
    };
    const call = async (turnId: string, name: string, args: Record<string, unknown>) => {
      const request = modernRequest('tools/call', { name, arguments: args }, name);
      request.headers.set('Electrosphere-Thread-Id', 'instant-http');
      request.headers.set('Electrosphere-Turn-Id', turnId);
      return (await app.fetch(request)).json() as Promise<{ result: { isError?: boolean; structuredContent: Record<string, unknown> } }>;
    };

    const first = await start('turn-1');
    expect(stack.repository.getInstance(first.instanceId)?.backend).toBe('firecracker');
    await call('turn-1', 'write', { path: 'ephemeral.txt', content: 'ephemeral' });
    expect((await call('turn-1', 'read', { path: 'ephemeral.txt' })).result.structuredContent).toMatchObject({ content: 'ephemeral' });
    expect((await call('turn-1', 'shell', { action: 'exec', command: 'printf same-runtime' })).result.structuredContent).toMatchObject({ output: 'same-runtime' });
    await stack.turns.finish({ threadId: 'instant-http', turnId: 'turn-1' });

    const second = await start('turn-2');
    expect(second.instanceId).not.toBe(first.instanceId);
    const missing = await call('turn-2', 'read', { path: 'ephemeral.txt' });
    expect(missing.result.isError).toBe(true);
    expect(missing.result.structuredContent).toMatchObject({ code: 'NOT_FOUND' });
    expect(stack.repository.getThreadWorkspace('instant-http')).toBeUndefined();
  });

  test('commits durable turns, enforces conflicts, and forks only through harness routes', async () => {
    const { app, stack } = await appStack();
    const start = async (threadId: string, turnId: string, body: Record<string, unknown>) => app.request(
      `/v1/harness/threads/${threadId}/turns/${turnId}`,
      {
        method: 'POST',
        headers: { Host: '127.0.0.1', Authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    const call = async (threadId: string, turnId: string, name: string, args: Record<string, unknown>) => {
      const request = modernRequest('tools/call', { name, arguments: args }, name);
      request.headers.set('Electrosphere-Thread-Id', threadId);
      request.headers.set('Electrosphere-Turn-Id', turnId);
      return (await app.fetch(request)).json() as Promise<{ result: { isError?: boolean; structuredContent: Record<string, unknown> } }>;
    };

    const firstStart = await start('durable-http', 'turn-1', { mode: 'durable', backend: 'docker' });
    expect(firstStart.status).toBe(201);
    const first = await firstStart.json() as { workspaceId: string; headCommit: string };
    const changedBody = await start('durable-http', 'turn-1', { mode: 'durable', backend: 'firecracker' });
    expect(await changedBody.json()).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } });
    const busy = await start('durable-http', 'turn-2', { mode: 'durable', backend: 'docker' });
    expect(await busy.json()).toMatchObject({ error: { code: 'THREAD_BUSY' } });
    const parallel = await start('parallel-http', 'turn-1', { mode: 'durable', backend: 'docker' });
    expect(parallel.status).toBe(201);

    await call('durable-http', 'turn-1', 'write', { path: 'durable.txt', content: 'persisted' });
    expect((await call('durable-http', 'turn-1', 'read', { path: 'missing.txt' })).result.isError).toBe(true);
    const firstFinished = await stack.turns.finish({ threadId: 'durable-http', turnId: 'turn-1' });
    await stack.turns.finish({ threadId: 'parallel-http', turnId: 'turn-1' });
    expect(firstFinished.headCommit).not.toBe(first.headCommit);

    expect((await start('durable-http', 'turn-2', { mode: 'durable', backend: 'docker' })).status).toBe(201);
    expect((await call('durable-http', 'turn-2', 'read', { path: 'durable.txt' })).result.structuredContent).toMatchObject({ content: 'persisted' });
    const secondFinished = await stack.turns.finish({ threadId: 'durable-http', turnId: 'turn-2' });
    expect(secondFinished.headCommit).not.toBe(firstFinished.headCommit);
    expect(stack.repository.getCommit(secondFinished.headCommit!)?.parentId).toBe(firstFinished.headCommit);

    const forked = await app.request('/v1/harness/threads/durable-http/forks/fork-http', {
      method: 'POST',
      headers: { Host: '127.0.0.1', Authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(forked.status).toBe(201);
    expect((await start('fork-http', 'turn-1', { mode: 'durable', backend: 'docker' })).status).toBe(201);
    expect((await call('fork-http', 'turn-1', 'read', { path: 'durable.txt' })).result.structuredContent).toMatchObject({ content: 'persisted' });
    await stack.turns.finish({ threadId: 'fork-http', turnId: 'turn-1' });
  });

  test('serves MCP through a real Bun HTTP body stream', async () => {
    const { app } = await appStack();
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch });
    try {
      const request = modernRequest('tools/list', {});
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: 'POST',
        headers: request.headers,
        body: await request.text(),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { result: { tools: Array<{ name: string }> } };
      expect(body.result.tools).toHaveLength(10);
    } finally {
      server.stop(true);
    }
  });
  test('finish blocks new leases and waits for an in-flight file tool before snapshot', async () => {
    const { app, stack } = await appStack();
    await stack.turns.start({ threadId: 'lease-thread', turnId: 'turn-1', mode: 'durable', backend: 'docker' });
    let releaseWrite!: () => void;
    stack.docker.fileWriteWait = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    stack.docker.onFileWrite = markStarted;

    const writeRequest = modernRequest('tools/call', {
      name: 'write',
      arguments: { path: 'leased.txt', content: 'committed-before-snapshot' },
    }, 'write');
    writeRequest.headers.set('Electrosphere-Thread-Id', 'lease-thread');
    writeRequest.headers.set('Electrosphere-Turn-Id', 'turn-1');
    const writeResponse = app.fetch(writeRequest);

    await started;
    const finish = stack.turns.finish({ threadId: 'lease-thread', turnId: 'turn-1' });
    expect(stack.repository.getTurn('lease-thread', 'turn-1')?.state).toBe('FINISHING');
    expect(stack.docker.snapshotCount).toBe(0);

    const rejected = modernRequest('tools/call', { name: 'read', arguments: { path: 'leased.txt' } }, 'read');
    rejected.headers.set('Electrosphere-Thread-Id', 'lease-thread');
    rejected.headers.set('Electrosphere-Turn-Id', 'turn-1');
    expect(await (await app.fetch(rejected)).json()).toMatchObject({ error: { data: { code: 'TURN_CLOSED' } } });

    releaseWrite();
    expect((await writeResponse).status).toBe(200);
    await finish;
    delete stack.docker.fileWriteWait;
    delete stack.docker.onFileWrite;
    await stack.turns.start({ threadId: 'lease-thread', turnId: 'turn-2', mode: 'durable', backend: 'docker' });
    const readRequest = modernRequest('tools/call', { name: 'read', arguments: { path: 'leased.txt' } }, 'read');
    readRequest.headers.set('Electrosphere-Thread-Id', 'lease-thread');
    readRequest.headers.set('Electrosphere-Turn-Id', 'turn-2');
    expect(await (await app.fetch(readRequest)).json()).toMatchObject({ result: { structuredContent: { content: 'committed-before-snapshot' } } });
  });
  test('exposes only bound-turn shell and file tools through stateless modern MCP', async () => {
    const { app } = await appStack();
    const first = await app.fetch(modernRequest('tools/list', {}));

    const second = await app.fetch(modernRequest('tools/list', {}));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get('Mcp-Session-Id')).toBeNull();
    expect(second.headers.get('Mcp-Session-Id')).toBeNull();
    const body = await first.json() as { result: { tools: Array<{ name: string; inputSchema: unknown }> } };
    expect(body.result.tools.map((tool) => tool.name)).toEqual(['shell', 'read', 'write', 'edit', 'glob', 'grep', 'move', 'remove', 'artifact_export', 'artifact_materialize']);
    expect(JSON.stringify(body.result.tools)).not.toContain('target');

    const discover = await app.fetch(modernRequest('server/discover', {}));
    expect(discover.status).toBe(200);
    expect(await discover.json()).toMatchObject({ result: { supportedVersions: ['2026-07-28'] } });
  });

  test('serves OMP-compatible 2025 MCP without transport sessions', async () => {
    const { app, stack } = await appStack();
    const initialized = await app.fetch(legacyRequest('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'omp', version: '17.4.0' },
    }));
    expect(initialized.status).toBe(200);
    expect(initialized.headers.get('Mcp-Session-Id')).toBeNull();
    expect(await legacyJson(initialized)).toMatchObject({ result: { protocolVersion: '2025-11-25' } });

    const listed = await app.fetch(legacyRequest('tools/list', {}));
    expect(listed.status).toBe(200);
    expect(listed.headers.get('Mcp-Session-Id')).toBeNull();
    const listedBody = await legacyJson(listed) as { result: { tools: Array<{ name: string }> } };
    expect(listedBody.result.tools.map((tool) => tool.name)).toEqual(['shell', 'read', 'write', 'edit', 'glob', 'grep', 'move', 'remove', 'artifact_export', 'artifact_materialize']);

    await stack.turns.start({ threadId: 'test-thread', turnId: 'test-turn', mode: 'instant' });
    const written = await app.fetch(legacyRequest('tools/call', {
      name: 'write',
      arguments: { path: 'legacy.txt', content: 'legacy' },
    }));
    expect(await legacyJson(written)).toMatchObject({ result: { structuredContent: { path: 'legacy.txt', size: 6 } } });
    const read = await app.fetch(legacyRequest('tools/call', {
      name: 'read',
      arguments: { path: 'legacy.txt' },
    }));
    expect(await legacyJson(read)).toMatchObject({ result: { structuredContent: { content: 'legacy' } } });
  });

  test('executes shell and returns text plus structured content', async () => {
    const { app, stack } = await appStack();
    await stack.turns.start({ threadId: 'test-thread', turnId: 'test-turn', mode: 'instant' });
    const response = await app.fetch(modernRequest('tools/call', {
      name: 'shell',
      arguments: {
        action: 'exec',
        command: 'printf hello',
      },
    }, 'shell'));
    expect(response.status).toBe(200);
    const body = await response.json() as { result: { content: unknown[]; structuredContent: { status: string; output: string } } };
    expect(body.result.content).toHaveLength(1);
    expect(body.result.structuredContent).toMatchObject({ status: 'completed', output: 'hello' });
  });

  test('retains bound runtime session ownership across stateless MCP requests', async () => {
    const { app, stack } = await appStack();
    const turn = await stack.turns.start({ threadId: 'test-thread', turnId: 'test-turn', mode: 'instant' });
    const startedResponse = await app.fetch(modernRequest('tools/call', {
      name: 'shell',
      arguments: { action: 'exec', command: 'sleep 1; printf bound', yield_time_ms: 250 },
    }, 'shell'));
    const started = await startedResponse.json() as { result: { structuredContent: { session_id: string; status: string } } };
    expect(started.result.structuredContent.status).toBe('running');
    expect(stack.repository.getInstance(turn.instanceId!)?.state).toBe('RUNNING');
    await stack.turns.start({ threadId: 'other-session-thread', turnId: 'turn-1', mode: 'instant' });
    const foreignPoll = modernRequest('tools/call', {
      name: 'shell',
      arguments: { action: 'poll', session_id: started.result.structuredContent.session_id, yield_time_ms: 5000 },
    }, 'shell');
    foreignPoll.headers.set('Electrosphere-Thread-Id', 'other-session-thread');
    foreignPoll.headers.set('Electrosphere-Turn-Id', 'turn-1');
    const foreignBody = await (await app.fetch(foreignPoll)).json() as { result: { isError: boolean; structuredContent: Record<string, unknown> } };
    expect(foreignBody.result.isError).toBe(true);
    expect(foreignBody.result.structuredContent).toMatchObject({ code: 'NOT_FOUND' });

    const pollResponse = await app.fetch(modernRequest('tools/call', {
      name: 'shell',
      arguments: { action: 'poll', session_id: started.result.structuredContent.session_id, yield_time_ms: 5000 },
    }, 'shell'));
    const completed = await pollResponse.json() as { result: { structuredContent: { status: string; output: string } } };
    expect(completed.result.structuredContent).toMatchObject({ status: 'completed', output: 'bound' });
    expect(stack.repository.getInstance(turn.instanceId!)?.state).toBe('READY');
  });

  test('operates all workspace file tools on the bound turn runtime', async () => {
    const { app, stack } = await appStack();
    await stack.turns.start({ threadId: 'test-thread', turnId: 'test-turn', mode: 'instant' });
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await app.fetch(modernRequest('tools/call', { name, arguments: args }, name));
      expect(response.status).toBe(200);
      return response.json() as Promise<{ result: { isError?: boolean; structuredContent: Record<string, unknown> } }>;
    };
    await call('write', { path: 'ascii.bin', content: 'A'.repeat(20_000) });
    const binaryRead = await call('read', { path: 'ascii.bin' });
    expect(binaryRead.result.structuredContent.artifact).toMatch(/^artifact:\/\/sha256:[0-9a-f]{64}$/);
    expect(binaryRead.result.structuredContent.content).toBeUndefined();

    const written = await call('write', { path: 'notes.txt', content: 'alpha\nbeta\n' });
    expect(written.result.structuredContent).toMatchObject({ path: 'notes.txt', size: 11 });
    const firstRead = await call('read', { path: '/workspace/notes.txt' });
    expect(firstRead.result.structuredContent).toMatchObject({ content: 'alpha\nbeta\n' });
    const digest = firstRead.result.structuredContent.digest as string;
    const edited = await call('edit', {
      path: 'notes.txt',
      expected_digest: digest,
      edits: [{ kind: 'replace', start_line: 2, end_line: 2, content: 'gamma\n' }],
    });
    expect(edited.result.structuredContent).toMatchObject({ lines_before: 2, lines_after: 2 });
    const afterReplace = await call('read', { path: 'notes.txt' });
    const replacedDigest = afterReplace.result.structuredContent.digest as string;
    const stale = await call('edit', {
      path: 'notes.txt',
      expected_digest: digest,
      edits: [{ kind: 'delete', start_line: 1, end_line: 1 }],
    });
    expect(stale.result.isError).toBe(true);
    expect(stale.result.structuredContent).toMatchObject({ code: 'HEAD_CONFLICT', details: { currentDigest: replacedDigest } });

    await call('edit', {
      path: 'notes.txt',
      expected_digest: replacedDigest,
      edits: [{ kind: 'insert_before', start_line: 1, content: 'zero\n' }],
    });
    const beforeAfter = await call('read', { path: 'notes.txt' });
    await call('edit', {
      path: 'notes.txt',
      expected_digest: beforeAfter.result.structuredContent.digest,
      edits: [{ kind: 'insert_after', start_line: 2, content: 'between\n' }],
    });
    const inserted = await call('read', { path: 'notes.txt' });
    await call('edit', {
      path: 'notes.txt',
      expected_digest: inserted.result.structuredContent.digest,
      edits: [{ kind: 'delete', start_line: 3, end_line: 3 }],
    });
    expect((await call('read', { path: 'notes.txt' })).result.structuredContent).toMatchObject({ content: 'zero\nalpha\ngamma\n' });
    expect((await call('read', { path: 'notes.txt', ranges: [{ start: 1, end: 1 }, { start: 3, end: 3 }] })).result.structuredContent).toMatchObject({
      lines: [{ line: 1, text: 'zero\n' }, { line: 3, text: 'gamma\n' }],
    });
    expect((await call('read', { path: 'notes.txt', raw: true })).result.structuredContent).toMatchObject({
      content: Buffer.from('zero\nalpha\ngamma\n').toString('base64'),
      encoding: 'base64',
    });
    expect((await call('read', { path: '.' })).result.structuredContent).toMatchObject({ is_directory: true });

    await call('write', { path: '.hidden.txt', content: 'hidden' });
    await call('write', { path: 'regex.txt', content: `${'a'.repeat(2_000)}b` });
    const globbed = await call('glob', { pattern: '**/*.txt', hidden: false, sort: 'modified' });
    expect(JSON.stringify(globbed.result.structuredContent)).not.toContain('.hidden.txt');
    const paged = await call('glob', { pattern: '**/*.txt', hidden: true, limit: 1, sort: 'name' });
    expect(paged.result.structuredContent).toMatchObject({ truncated: true });
    expect(paged.result.structuredContent.next_cursor).toBeDefined();

    const searched = await call('grep', { pattern: 'gamm(?=a)', paths: ['.'], context_before: 1 });
    expect(searched.result.structuredContent).toMatchObject({ matches: [{ path: 'notes.txt', line: 3, text: 'gamma', context_before: ['alpha'] }], total_matches: 1 });
    expect((await call('grep', { pattern: 'zero\\nalpha', paths: ['notes.txt'] })).result.structuredContent).toMatchObject({ total_matches: 1 });
    const limited = await call('grep', { pattern: '(?=(a+)+$)', paths: ['regex.txt'] });
    expect(limited.result.isError).toBe(true);
    expect(limited.result.structuredContent).toMatchObject({ code: 'INVALID_ARGUMENT' });
    const unsafe = await call('read', { path: 'a/../b' });
    expect(unsafe.result.structuredContent).toMatchObject({ code: 'INVALID_ARGUMENT' });
    await call('move', { source: 'notes.txt', destination: 'moved.txt' });
    await call('remove', { path: 'moved.txt' });
    const missing = await call('read', { path: 'moved.txt' });
    expect(missing.result.isError).toBe(true);
    expect(missing.result.structuredContent).toMatchObject({ code: 'NOT_FOUND' });
  });


  test('exports, reads, and materializes thread-scoped artifacts across turns', async () => {
    const { app, stack } = await appStack();
    await stack.turns.start({ threadId: 'test-thread', turnId: 'test-turn', mode: 'instant' });
    const call = async (name: string, args: Record<string, unknown>, threadId = 'test-thread', turnId = 'test-turn') => {
      const request = modernRequest('tools/call', { name, arguments: args }, name);
      request.headers.set('Electrosphere-Thread-Id', threadId);
      request.headers.set('Electrosphere-Turn-Id', turnId);
      const response = await app.fetch(request);
      expect(response.status).toBe(200);
      return response.json() as Promise<{ result: { isError?: boolean; structuredContent: Record<string, unknown> } }>;
    };
    await call('write', { path: 'artifact.txt', content: 'artifact roundtrip\n' });
    const exported = await call('artifact_export', { path: 'artifact.txt', media_type: 'text/plain' });
    const uri = exported.result.structuredContent.uri as string;
    expect(uri).toMatch(/^artifact:\/\/sha256:[0-9a-f]{64}$/);
    const read = await call('read', { path: uri });
    expect(read.result.structuredContent).toMatchObject({ artifact: uri, content: 'artifact roundtrip\n' });
    const materialized = await call('artifact_materialize', { artifact: uri, path: 'copy/artifact.txt', create_parents: true });
    expect(materialized.result.structuredContent).toMatchObject({ path: 'copy/artifact.txt', size: 19 });
    expect((await call('read', { path: 'copy/artifact.txt' })).result.structuredContent).toMatchObject({ content: 'artifact roundtrip\n' });

    await stack.turns.finish({ threadId: 'test-thread', turnId: 'test-turn' });
    await stack.turns.start({ threadId: 'test-thread', turnId: 'test-turn-2', mode: 'instant' });
    expect((await call('read', { path: uri }, 'test-thread', 'test-turn-2')).result.structuredContent).toMatchObject({ content: 'artifact roundtrip\n' });

    await stack.turns.start({ threadId: 'other-thread', turnId: 'other-turn', mode: 'instant' });
    const denied = await call('read', { path: uri }, 'other-thread', 'other-turn');
    expect(denied.result.isError).toBe(true);
    expect(denied.result.structuredContent).toMatchObject({ code: 'NOT_FOUND' });
  });
  test('paginates glob and grep before the MCP frame limit', async () => {
    const { app, stack } = await appStack();
    const turn = await stack.turns.start({ threadId: 'test-thread', turnId: 'test-turn', mode: 'instant' });
    const workspace = stack.service.getTurnHandle(turn.instanceId!).instance.workspacePath;
    await mkdir(`${workspace}/bulk`);
    const suffix = 'x'.repeat(210);
    const text = `match-${'y'.repeat(400)}\n`;
    for (let start = 0; start < 6_000; start += 200) {
      await Promise.all(Array.from({ length: 200 }, (_, offset) => {
        const index = start + offset;
        return Bun.write(`${workspace}/bulk/${index}-${suffix}.txt`, text);
      }));
    }
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await app.fetch(modernRequest('tools/call', { name, arguments: args }, name));
      expect(response.status).toBe(200);
      const body = await response.json() as { result: { structuredContent: Record<string, unknown> } };
      expect(Buffer.byteLength(JSON.stringify(body.result.structuredContent))).toBeLessThanOrEqual(1_520_000);
      return body.result.structuredContent;
    };

    const firstGlob = await call('glob', { pattern: 'bulk/*', limit: 10_000, sort: 'name' });
    expect(firstGlob).toMatchObject({ truncated: true });
    expect(firstGlob.next_cursor).toBeDefined();
    const firstGlobEntries = firstGlob.entries as Array<{ path: string }>;
    const secondGlob = await call('glob', { pattern: 'bulk/*', limit: 10_000, sort: 'name', cursor: firstGlob.next_cursor });
    const secondGlobEntries = secondGlob.entries as Array<{ path: string }>;
    expect(secondGlobEntries[0]?.path).not.toBe(firstGlobEntries.at(-1)?.path);

    const firstGrep = await call('grep', { pattern: 'match-', paths: ['bulk/*'], limit: 10_000 });
    expect(firstGrep).toMatchObject({ truncated: true, total_matches: 6_000 });
    expect(firstGrep.next_cursor).toBeDefined();
    const firstGrepMatches = firstGrep.matches as Array<{ path: string }>;
    const secondGrep = await call('grep', { pattern: 'match-', paths: ['bulk/*'], limit: 10_000, cursor: firstGrep.next_cursor });
    const secondGrepMatches = secondGrep.matches as Array<{ path: string }>;
    expect(secondGrepMatches[0]?.path).not.toBe(firstGrepMatches.at(-1)?.path);
  }, 60_000);
  test('rejects protocol/header mismatches, invalid hosts, and unsupported methods', async () => {
    const { app } = await appStack();
    const mismatch = modernRequest('tools/list', {});
    mismatch.headers.set('Mcp-Method', 'tools/call');

    expect((await app.fetch(mismatch)).status).toBe(400);

    const unsupported = await app.fetch(modernRequest('tools/list', {}, undefined, '2099-01-01'));
    expect(unsupported.status).toBe(400);

    const invalidHost = await app.request('/healthz', { headers: { Host: 'evil.example' } });
    expect(invalidHost.status).toBe(403);
    const invalidOrigin = await app.request('/healthz', { headers: { Host: '127.0.0.1', Origin: 'https://evil.example' } });
    expect(invalidOrigin.status).toBe(403);

    expect((await app.request('/mcp', { method: 'GET', headers: { Host: '127.0.0.1', Authorization: 'Bearer test-token' } })).status).toBe(405);
    expect((await app.request('/mcp', { method: 'DELETE', headers: { Host: '127.0.0.1', Authorization: 'Bearer test-token' } })).status).toBe(405);
  });
});
