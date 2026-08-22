import { afterEach, describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { createTestStack, type TestStack } from './helpers.ts';

const stacks: TestStack[] = [];

afterEach(async () => {
  await Promise.all(stacks.splice(0).map((stack) => stack.close()));
});

async function stack(): Promise<TestStack> {
  const value = await createTestStack();
  stacks.push(value);
  return value;
}

describe('TurnService and SandboxService', () => {
  test('starts durable turns idempotently and binds one workspace per thread', async () => {
    const current = await stack();
    const first = await current.turns.start({ threadId: 'idempotent-thread', turnId: 'turn-1', mode: 'durable', backend: 'docker' });
    const second = await current.turns.start({ threadId: 'idempotent-thread', turnId: 'turn-1', mode: 'durable', backend: 'docker' });
    expect(second).toEqual(first);
    expect(first.headCommit).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(current.repository.getThreadWorkspace('idempotent-thread')?.workspaceId).toBe(first.workspaceId);
    await current.turns.finish({ threadId: 'idempotent-thread', turnId: 'turn-1' });
  });

  test('forks independent thread refs and commits only the selected fork', async () => {
    const current = await stack();
    const source = await current.turns.start({ threadId: 'source-thread', turnId: 'turn-1', mode: 'durable', backend: 'docker' });
    await writeFile(`${current.service.getTurnHandle(source.instanceId!).instance.workspacePath}/source.txt`, 'source');
    const sourceFinished = await current.turns.finish({ threadId: 'source-thread', turnId: 'turn-1' });
    const forkA = await current.turns.fork({ sourceThreadId: 'source-thread', destinationThreadId: 'fork-a' });
    const forkB = await current.turns.fork({ sourceThreadId: 'source-thread', destinationThreadId: 'fork-b' });

    const forkATurn = await current.turns.start({ threadId: 'fork-a', turnId: 'turn-1', mode: 'durable', backend: 'docker' });
    await writeFile(`${current.service.getTurnHandle(forkATurn.instanceId!).instance.workspacePath}/only-a.txt`, 'A');
    const forkAFinished = await current.turns.finish({ threadId: 'fork-a', turnId: 'turn-1' });

    expect(forkAFinished.headCommit).not.toBe(sourceFinished.headCommit);
    expect(current.repository.getRef(forkA.workspaceId, 'main')?.headCommit).toBe(forkAFinished.headCommit);
    expect(current.repository.getRef(forkB.workspaceId, 'main')?.headCommit).toBe(sourceFinished.headCommit);
    expect(current.repository.getRef(source.workspaceId!, 'main')?.headCommit).toBe(sourceFinished.headCommit);
  });

  test('allows only one active turn per thread while other threads proceed', async () => {
    const current = await stack();
    await current.turns.start({ threadId: 'busy-thread', turnId: 'turn-1', mode: 'durable', backend: 'docker' });
    await expect(current.turns.start({ threadId: 'busy-thread', turnId: 'turn-2', mode: 'durable', backend: 'docker' })).rejects.toMatchObject({ code: 'THREAD_BUSY' });
    await current.turns.start({ threadId: 'parallel-thread', turnId: 'turn-1', mode: 'durable', backend: 'docker' });
    await current.turns.finish({ threadId: 'busy-thread', turnId: 'turn-1' });
    await current.turns.finish({ threadId: 'parallel-thread', turnId: 'turn-1' });
  });

  test('destroys instant state without creating a thread workspace', async () => {
    const current = await stack();
    const first = await current.turns.start({ threadId: 'instant-thread', turnId: 'turn-1', mode: 'instant' });
    await writeFile(`${current.service.getTurnHandle(first.instanceId!).instance.workspacePath}/discarded`, 'discarded');
    await current.turns.finish({ threadId: 'instant-thread', turnId: 'turn-1' });
    const second = await current.turns.start({ threadId: 'instant-thread', turnId: 'turn-2', mode: 'instant' });
    expect(second.instanceId).not.toBe(first.instanceId);
    expect(current.repository.getThreadWorkspace('instant-thread')).toBeUndefined();
    const { instance, handle } = current.service.getTurnHandle(second.instanceId!);
    await expect(current.backends.get(instance.backend).fileRead(handle, { path: 'discarded' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await current.turns.finish({ threadId: 'instant-thread', turnId: 'turn-2' });
  });

  test('commits durable turns and materializes the next turn from the new head', async () => {
    const current = await stack();
    const first = await current.turns.start({ threadId: 'durable-thread', turnId: 'turn-1', mode: 'durable', backend: 'docker' });
    const firstHandle = current.service.getTurnHandle(first.instanceId!);
    await writeFile(`${firstHandle.instance.workspacePath}/durable.txt`, 'persisted');
    const firstFinished = await current.turns.finish({ threadId: 'durable-thread', turnId: 'turn-1' });
    expect(firstFinished.state).toBe('FINISHED');
    expect(firstFinished.headCommit).not.toBe(first.headCommit);
    expect(current.repository.getInstance(first.instanceId!)?.state).toBe('TERMINATED');

    const second = await current.turns.start({ threadId: 'durable-thread', turnId: 'turn-2', mode: 'durable', backend: 'docker' });
    const secondHandle = current.service.getTurnHandle(second.instanceId!);
    expect(await readFile(`${secondHandle.instance.workspacePath}/durable.txt`, 'utf8')).toBe('persisted');
    const secondFinished = await current.turns.finish({ threadId: 'durable-thread', turnId: 'turn-2' });
    expect(secondFinished.headCommit).not.toBe(firstFinished.headCommit);
    expect(current.repository.getCommit(secondFinished.headCommit!)?.parentId).toBe(firstFinished.headCommit);
  });

  test('commits files larger than four MiB through one snapshot and restores them', async () => {
    const current = await stack();
    const first = await current.turns.start({ threadId: 'large-thread', turnId: 'turn-1', mode: 'durable', backend: 'docker' });
    const { handle } = current.service.getTurnHandle(first.instanceId!);
    const bytes = new Uint8Array(5 * 1024 * 1024 + 123).fill(0x5a);
    await current.docker.fileWrite(handle, {
      path: 'large.bin',
      source: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
      createParents: false,
    });
    const snapshotsBefore = current.docker.snapshotCount;
    await current.turns.finish({ threadId: 'large-thread', turnId: 'turn-1' });
    expect(current.docker.snapshotCount).toBe(snapshotsBefore + 1);

    const second = await current.turns.start({ threadId: 'large-thread', turnId: 'turn-2', mode: 'durable', backend: 'docker' });
    const secondHandle = current.service.getTurnHandle(second.instanceId!).handle;
    const stat = await current.docker.fileStat(secondHandle, { path: 'large.bin' });
    expect(stat.size).toBe(bytes.byteLength);
    const suffix = await current.docker.fileReadBytes(secondHandle, { path: 'large.bin', offset: bytes.byteLength - 123, limit: 123 });
    expect(Buffer.from(suffix.data).equals(Buffer.alloc(123, 0x5a))).toBe(true);
    await current.turns.finish({ threadId: 'large-thread', turnId: 'turn-2' });
  });

  test('close waits for a concurrent STARTING runtime and leaves no live instance', async () => {
    const current = await stack();
    let releaseCreate!: () => void;
    current.firecracker.createWait = new Promise<void>((resolve) => { releaseCreate = resolve; });
    let markStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    current.firecracker.onCreate = markStarted;
    const start = current.turns.start({ threadId: 'closing-thread', turnId: 'turn-1', mode: 'instant' });
    await createStarted;
    const close = current.turns.close();
    releaseCreate();
    await Promise.allSettled([start]);
    await close;
    expect(current.repository.listTurns(['STARTING', 'OPEN', 'FINISHING'])).toHaveLength(0);
    expect(current.firecracker.instances.size).toBe(0);
  });
});
