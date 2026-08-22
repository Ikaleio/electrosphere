import { afterEach, describe, expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendRegistry } from '../src/backends/types.ts';
import { RecoveryManager } from '../src/domain/recovery.ts';
import { harnessRequestId } from '../src/domain/turn-service.ts';
import { EMPTY_CONTRACT_DIGEST } from '../src/domain/types.ts';
import { commitDigest, exportCfs } from '../src/storage/cfs.ts';
import { Repository } from '../src/storage/repository.ts';
import { openStorage } from '../src/storage/sqlite.ts';
import { FakeBackend } from './fake-backend.ts';
import { createTestStack, type TestStack } from './helpers.ts';

const roots: string[] = [];
const stacks: TestStack[] = [];

afterEach(async () => {
  await Promise.all(stacks.splice(0).map((stack) => stack.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('storage startup and recovery', () => {
  test('applies the generated migration once and preserves WAL settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storage-test-'));
    roots.push(root);
    const first = await openStorage(root);
    const firstCount = first.sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM __drizzle_migrations').get()?.count;
    expect(firstCount).toBe(2);
    expect(first.sqlite.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
    expect(first.sqlite.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    first.close();

    const second = await openStorage(root);
    expect(second.sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM __drizzle_migrations').get()?.count).toBe(2);
    second.close();
  });

  test('removes incomplete staging and marks interrupted instances lost', async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const turn = await stack.turns.start({ threadId: 'recovery-thread', turnId: 'turn-1', mode: 'instant' });
    stack.repository.updateInstance(turn.instanceId!, { state: 'RUNNING' });
    stack.repository.beginHarnessOperation('crashed-operation-id', 'crashed-operation', 'crashed-request');
    const staging = join(stack.root, 'staging');
    await mkdir(staging, { recursive: true });
    const orphan = join(staging, 'orphan.cfs');
    await writeFile(orphan, 'partial');

    const recovery = new RecoveryManager(stack.root, stack.repository, stack.backends);
    await recovery.recover();
    expect(stack.repository.getInstance(turn.instanceId!)?.state).toBe('LOST');
    expect(stack.firecracker.instances.has(turn.instanceId!)).toBe(false);
    expect(stack.repository.getTurn('recovery-thread', 'turn-1')).toMatchObject({
      state: 'FAILED',
      errorJson: JSON.stringify({ code: 'TURN_CLOSED', message: 'Daemon restarted during active turn' }),
    });
    await expect(access(orphan)).rejects.toBeDefined();
    expect(stack.repository.getOperation('crashed-operation', 'crashed-request')).toBeUndefined();
  });

  test('publishes commit, ref, operation, and turn completion atomically', async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const turn = await stack.turns.start({ threadId: 'atomic-thread', turnId: 'turn-1', mode: 'durable', backend: 'docker' });
    const source = join(stack.root, 'atomic-source');
    await mkdir(source);
    await writeFile(join(source, 'result'), 'committed');
    const tree = await exportCfs(source, join(stack.root, 'objects', 'trees'));
    const commit = commitDigest(EMPTY_CONTRACT_DIGEST, tree.treeDigest, turn.headCommit!);
    const operationId = harnessRequestId('finish', 'atomic-thread', 'turn-1');
    stack.repository.beginHarnessOperation(operationId, 'commit_turn_runtime', operationId);
    stack.repository.updateTurn('atomic-thread', 'turn-1', { state: 'FINISHING' });
    const response = {
      threadId: 'atomic-thread',
      turnId: 'turn-1',
      mode: 'durable',
      state: 'FINISHED',
      instanceId: turn.instanceId,
      workspaceId: turn.workspaceId,
      headCommit: commit,
    };

    expect(stack.repository.publishTurnCommit({
      operationId,
      threadId: 'atomic-thread',
      turnId: 'turn-1',
      instanceId: turn.instanceId!,
      workspaceId: turn.workspaceId!,
      ref: 'main',
      expectedHead: turn.headCommit!,
      tree: { digest: tree.treeDigest, path: tree.path, sizeBytes: tree.sizeBytes },
      commit: { id: commit, contractDigest: EMPTY_CONTRACT_DIGEST, parentId: turn.headCommit! },
      response,
    })).toBe(true);
    expect(stack.repository.getOperation<typeof response>('commit_turn_runtime', operationId)).toEqual(response);
    expect(stack.repository.getRef(turn.workspaceId!, 'main')?.headCommit).toBe(commit);
    expect(stack.repository.getTurn('atomic-thread', 'turn-1')?.state).toBe('FINISHED');

    const recovery = new RecoveryManager(stack.root, stack.repository, stack.backends);
    await recovery.recover();
    expect(stack.repository.getTurn('atomic-thread', 'turn-1')?.state).toBe('FINISHED');
    expect(stack.repository.getRef(turn.workspaceId!, 'main')?.headCommit).toBe(commit);
    expect(stack.repository.getInstance(turn.instanceId!)?.state).toBe('TERMINATED');
  });


  test('retries cleanup for a finished durable turn without changing its commit', async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const turn = await stack.turns.start({ threadId: 'cleanup-thread', turnId: 'turn-1', mode: 'durable', backend: 'docker' });
    await writeFile(`${stack.service.getTurnHandle(turn.instanceId!).instance.workspacePath}/committed.txt`, 'committed');
    stack.docker.destroyFailures = 1;
    const finished = await stack.turns.finish({ threadId: 'cleanup-thread', turnId: 'turn-1' });
    expect(stack.repository.getTurn('cleanup-thread', 'turn-1')?.state).toBe('FINISHED');
    expect(stack.repository.getInstance(turn.instanceId!)?.state).toBe('LOST');
    expect(stack.repository.getInstance(turn.instanceId!)?.backendHandle).not.toBeNull();

    const recovery = new RecoveryManager(stack.root, stack.repository, stack.backends);
    await recovery.gc();
    expect(stack.repository.getInstance(turn.instanceId!)?.state).toBe('TERMINATED');
    expect(stack.repository.getInstance(turn.instanceId!)?.backendHandle).toBeNull();
    expect(stack.repository.getTurn('cleanup-thread', 'turn-1')?.state).toBe('FINISHED');
    expect(stack.repository.getRef(turn.workspaceId!, 'main')?.headCommit).toBe(finished.headCommit);
  });

  test('marks STARTING and FINISHING turns failed without publishing a commit', async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    stack.repository.createTurn({
      threadId: 'starting-thread',
      turnId: 'turn-1',
      mode: 'instant',
      state: 'STARTING',
      requestJson: JSON.stringify({ mode: 'instant' }),
      createdAt: Date.now(),
    });
    const finishing = await stack.turns.start({ threadId: 'finishing-thread', turnId: 'turn-1', mode: 'durable', backend: 'docker' });
    stack.repository.updateTurn('finishing-thread', 'turn-1', { state: 'FINISHING' });
    const commitsBefore = stack.repository.listCommits().length;
    const headBefore = stack.repository.getRef(finishing.workspaceId!, 'main')?.headCommit;

    const recovery = new RecoveryManager(stack.root, stack.repository, stack.backends);
    await recovery.recover();
    expect(stack.repository.getTurn('starting-thread', 'turn-1')?.state).toBe('FAILED');
    expect(stack.repository.getTurn('finishing-thread', 'turn-1')?.state).toBe('FAILED');
    expect(stack.repository.listCommits()).toHaveLength(commitsBefore);
    expect(stack.repository.getRef(finishing.workspaceId!, 'main')?.headCommit).toBe(headBefore);
  });
  test('garbage collects unreferenced commits and immutable trees', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gc-test-'));
    roots.push(root);
    const storage = await openStorage(root);
    const repository = new Repository(storage.db);
    const docker = new FakeBackend('docker');
    const firecracker = new FakeBackend('firecracker');
    const backends = new BackendRegistry(docker, firecracker);
    const source = join(root, 'unreferenced-source');
    await mkdir(source);
    await writeFile(join(source, 'orphan'), 'orphan');
    const tree = await exportCfs(source, join(root, 'objects', 'trees'));
    const orphanPath = join(root, 'objects', 'trees', 'sha256', 'f'.repeat(64));
    await writeFile(orphanPath, 'orphan-tree');
    const commit = commitDigest(EMPTY_CONTRACT_DIGEST, tree.treeDigest);
    repository.putTreeObject({ digest: tree.treeDigest, path: tree.path, sizeBytes: tree.sizeBytes });
    repository.putCommit({ id: commit, treeDigest: tree.treeDigest, contractDigest: EMPTY_CONTRACT_DIGEST });
    const child = commitDigest(EMPTY_CONTRACT_DIGEST, tree.treeDigest, commit);
    repository.putCommit({ id: child, treeDigest: tree.treeDigest, contractDigest: EMPTY_CONTRACT_DIGEST, parentId: commit });

    const recovery = new RecoveryManager(root, repository, backends);
    const result = await recovery.gc();
    expect(result).toEqual({ deletedTrees: 2, deletedCommits: 2 });
    expect(repository.getCommit(child)).toBeUndefined();
    expect(repository.getCommit(commit)).toBeUndefined();
    expect(repository.getTreeObject(tree.treeDigest)).toBeUndefined();
    await expect(access(tree.path)).rejects.toBeDefined();
    await expect(access(orphanPath)).rejects.toBeDefined();
    storage.close();
  });
});
