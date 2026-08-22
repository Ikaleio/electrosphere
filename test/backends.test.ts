import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDockerCreateRequest } from '../src/backends/docker.ts';
import { AgentFileClient } from '../src/backends/agent-files.ts';
import { SocketFrameWriter } from '../src/backends/agent-transport.ts';
import { FirecrackerBackend } from '../src/backends/firecracker.ts';
import type { Config } from '../src/daemon/config.ts';
import { DEFAULT_RESOURCE_PROFILE } from '../src/domain/types.ts';
import type { AgentTransport } from '../src/backends/types.ts';
import { createTestStack, type TestStack } from './helpers.ts';

const roots: string[] = [];
const stacks: TestStack[] = [];

afterEach(async () => {
  await Promise.all(stacks.splice(0).map((stack) => stack.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('backend contracts', () => {
  test('constructs a locked-down Docker container request', () => {
    const request = buildDockerCreateRequest('runtime@sha256:abc', {
      instanceId: 'instance',
      workspacePath: '/private/workspace',
      resourceProfile: DEFAULT_RESOURCE_PROFILE,
      network: 'none',
    });
    expect(request).toMatchObject({
      User: '1000:1000',
      WorkingDir: '/workspace',
      NetworkDisabled: true,
      HostConfig: {
        ReadonlyRootfs: true,
        NetworkMode: 'none',
        Privileged: false,
        PublishAllPorts: false,
        IpcMode: 'private',
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Devices: [],
        PortBindings: {},
        Memory: 512 * 1024 * 1024,
        MemorySwap: 512 * 1024 * 1024,
        NanoCpus: 1_000_000_000,
        PidsLimit: 128,
      },
    });
    expect(Object.keys(request.HostConfig.Tmpfs)).toEqual(['/workspace', '/tmp', '/run']);
    expect(request.HostConfig.Tmpfs['/workspace']).toContain('size=1073741824');
    expect('Binds' in request.HostConfig).toBe(false);
  });

  test('marks Firecracker unavailable without affecting the fake Docker contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'firecracker-preflight-'));
    roots.push(root);
    const config: Config = {
      dataDir: root,
      host: '127.0.0.1',
      port: 8787,
      defaultBackend: 'docker',
      dockerSocket: '/var/run/docker.sock',
      maxOutputBytes: 1_048_576,
    };
    const firecracker = new FirecrackerBackend(config);
    const probe = await firecracker.preflight();
    expect(probe.available).toBe(false);
    expect(probe.reason).toContain('firecracker artifact is not configured');
  });

  test('runs the same instant execution contract through the fake Firecracker backend', async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const instant = await stack.turns.start({
      threadId: 'fake-firecracker-thread',
      turnId: 'turn-1',
      mode: 'instant',
    });
    const result = await stack.sessions.exec({
      instanceId: instant.instanceId!,
      command: 'printf firecracker',
      yieldTimeMs: 1000,
      timeoutMs: 0,
    });
    expect(result).toMatchObject({ status: 'completed', output: 'firecracker', exit_code: 0 });
  });

  test('drains every byte after partial socket writes', () => {
    const writer = new SocketFrameWriter();
    const received: Buffer[] = [];
    let allowance = 5;
    writer.attach({
      write(data) {
        const count = Math.min(allowance, data.byteLength);
        if (count > 0) received.push(Buffer.from(data.subarray(0, count)));
        allowance = 0;
        return count;
      },
    });
    const frame = Buffer.from('0123456789abcdefghij');
    writer.write(frame);
    while (Buffer.concat(received).byteLength < frame.byteLength) {
      allowance = 5;
      writer.drain();
    }
    expect(Buffer.concat(received)).toEqual(frame);
  });

  test('splits file streams into protocol-sized agent chunks and maps stale edits', async () => {
    const chunks: number[] = [];
    const transport: AgentTransport = {
      async request(request) {
        if (request.type === 'FileWriteChunk') {
          chunks.push(Buffer.from(request.data, 'base64').byteLength);
          return { ok: true };
        }
        if (request.type === 'FileWriteCommit') {
          return { ok: true, size: 900_000, digest: `sha256:${'a'.repeat(64)}` };
        }
        if (request.type === 'FileEdit') {
          return { ok: false, error: 'changed', errorCode: 'INVALID_EDIT', details: { currentDigest: `sha256:${'b'.repeat(64)}` } };
        }
        return { ok: true };
      },
      close() {},
    };
    const client = new AgentFileClient(transport);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(900_000));
        controller.close();
      },
    });
    await client.write({ path: 'large.bin', source, createParents: false });
    expect(chunks).toEqual([384 * 1024, 384 * 1024, 900_000 - 768 * 1024]);
    await expect(client.edit({
      path: 'stale.txt',
      expectedDigest: `sha256:${'a'.repeat(64)}`,
      edits: [{ kind: 'delete', startLine: 1, endLine: 1 }],
    })).rejects.toMatchObject({ code: 'HEAD_CONFLICT', details: { currentDigest: `sha256:${'b'.repeat(64)}` } });
  });

  test('implements isolated atomic file operations through the fake backend', async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const instant = await stack.turns.start({ threadId: 'fake-files-thread', turnId: 'turn-1', mode: 'instant' });
    const { handle } = stack.service.getTurnHandle(instant.instanceId!);
    const backend = stack.backends.get(handle.backend);
    const content = 'alpha\nbeta foobar\n';
    const written = await backend.fileWrite(handle, {
      path: 'nested/file.txt',
      source: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from(content)); controller.close(); } }),
      createParents: true,
    });
    expect(written.size).toBe(Buffer.byteLength(content));
    const read = await backend.fileRead(handle, { path: 'nested/file.txt' });
    expect(read.lines?.join('')).toBe(content);
    const bytes = await backend.fileReadBytes(handle, { path: 'nested/file.txt', offset: 6, limit: 4 });
    expect(Buffer.from(bytes.data).toString()).toBe('beta');

    await backend.fileEdit(handle, {
      path: 'nested/file.txt',
      expectedDigest: written.digest,
      edits: [{ kind: 'replace', startLine: 2, endLine: 2, content: 'changed\n' }],
    });
    await expect(backend.fileEdit(handle, {
      path: 'nested/file.txt',
      expectedDigest: written.digest,
      edits: [{ kind: 'delete', startLine: 1, endLine: 1 }],
    })).rejects.toMatchObject({ code: 'HEAD_CONFLICT' });

    await writeFile(`${handle.workspacePath}/.gitignore`, 'ignored.txt\n');
    await writeFile(`${handle.workspacePath}/ignored.txt`, 'ignored\n');
    await writeFile(`${handle.workspacePath}/.hidden.txt`, 'hidden\n');
    const glob = await backend.fileGlob(handle, { patterns: ['**/*.txt'], gitignore: true, hidden: false, sort: 'name' });
    expect(glob.entries.map((entry) => entry.path)).toEqual(['nested/file.txt']);
    const grep = await backend.fileGrep(handle, { pattern: 'chang(?=ed)', paths: ['nested'], contextBefore: 1 });
    expect(grep.matches).toMatchObject([{ path: 'nested/file.txt', line: 2, text: 'changed', contextBefore: ['alpha'] }]);

    await backend.fileMove(handle, { source: 'nested/file.txt', destination: 'nested/moved.txt' });
    expect((await backend.fileStat(handle, { path: 'nested/moved.txt' })).type).toBe('file');
    await backend.fileRemove(handle, { path: 'nested/moved.txt' });
    await expect(backend.fileStat(handle, { path: 'nested/moved.txt' })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const outside = `${stack.root}/outside.txt`;
    await writeFile(outside, 'outside');
    await symlink(outside, `${handle.workspacePath}/escape`);
    await expect(backend.fileReadBytes(handle, { path: 'escape', offset: 0, limit: 16 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(backend.fileRead(handle, { path: '../outside.txt' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    let pulls = 0;
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(Buffer.from('partial'));
        else controller.error(new Error('source failed'));
      },
    });
    await expect(backend.fileWrite(handle, { path: 'partial.txt', source: failing, createParents: false })).rejects.toThrow('source failed');
    expect(await Bun.file(`${handle.workspacePath}/partial.txt`).exists()).toBe(false);
  });
});
