import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackendHandle } from '../backends/types.ts';
import { BackendRegistry } from '../backends/types.ts';
import { ServiceError } from './errors.ts';
import {
  EMPTY_CONTRACT_DIGEST,
  type Backend,
  type Digest,
  type InstanceState,
  type InstanceView,
  type NetworkProfile,
  type ResourceProfile,
  type WorkspaceView,
} from './types.ts';
import { commitDigest, exportCfs, ingestCfs, materializeCfs } from '../storage/cfs.ts';
import { Repository, type InstanceRecord } from '../storage/repository.ts';

export interface TurnCommitResult {
  commitId: Digest;
  treeDigest: Digest;
  workspaceId: string;
  ref: 'main';
  headCommit: Digest;
}

export class SandboxService {
  private emptyCommit?: Digest;
  private readonly treeRoot: string;
  private readonly instanceRoot: string;

  constructor(
    private readonly dataDir: string,
    readonly repository: Repository,
    readonly backends: BackendRegistry,
  ) {
    this.treeRoot = join(dataDir, 'objects', 'trees');
    this.instanceRoot = join(dataDir, 'instances');
  }

  async initialize(): Promise<void> {
    await mkdir(this.treeRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.instanceRoot, { recursive: true, mode: 0o700 });
    const emptyRoot = join(this.dataDir, 'canonical-empty');
    await mkdir(emptyRoot, { recursive: true, mode: 0o700 });
    const tree = await exportCfs(emptyRoot, this.treeRoot);
    const id = commitDigest(EMPTY_CONTRACT_DIGEST, tree.treeDigest);
    this.repository.putTreeObject({ digest: tree.treeDigest, path: tree.path, sizeBytes: tree.sizeBytes });
    this.repository.putCommit({ id, treeDigest: tree.treeDigest, contractDigest: EMPTY_CONTRACT_DIGEST });
    this.emptyCommit = id;
  }

  getCanonicalEmptyCommit(): Digest {
    if (!this.emptyCommit) throw new Error('SandboxService is not initialized');
    return this.emptyCommit;
  }

  private workspaceView(id: string): WorkspaceView {
    const result = this.repository.loadWorkspaceRefs(id);
    if (!result) throw new ServiceError('NOT_FOUND', 'Thread workspace not found');
    const main = result.refs.find((ref) => ref.name === 'main');
    if (!main) throw new ServiceError('NOT_FOUND', 'Thread workspace main ref not found');
    return { workspaceId: id, ref: 'main', headCommit: main.headCommit as Digest };
  }

  async ensureThreadWorkspace(threadId: string): Promise<WorkspaceView> {
    const existing = this.repository.getThreadWorkspace(threadId);
    if (existing) return this.workspaceView(existing.workspaceId);
    const workspaceId = crypto.randomUUID();
    const headCommit = this.getCanonicalEmptyCommit();
    try {
      this.repository.createThreadWorkspace({ threadId, workspaceId, headCommit });
      return { workspaceId, ref: 'main', headCommit };
    } catch (error) {
      const created = this.repository.getThreadWorkspace(threadId);
      if (created) return this.workspaceView(created.workspaceId);
      throw error;
    }
  }

  async createTurnRuntime(input: {
    instanceId: string;
    kind: 'instant' | 'durable';
    baseCommit: Digest;
    workspaceId?: string;
    backend: Backend;
    network: NetworkProfile;
    resourceProfile: ResourceProfile;
  }): Promise<InstanceView> {
    const commit = this.repository.getCommit(input.baseCommit);
    if (!commit) throw new ServiceError('NOT_FOUND', 'Commit not found');
    const tree = this.repository.getTreeObject(commit.treeDigest as Digest);
    if (!tree) throw new ServiceError('NOT_FOUND', 'Commit tree object not found');
    if (input.kind === 'durable' && !input.workspaceId) throw new ServiceError('INVALID_ARGUMENT', 'Durable runtime requires a workspace');
    if (input.kind === 'instant' && input.workspaceId) throw new ServiceError('INVALID_ARGUMENT', 'Instant runtime cannot use a workspace');
    const backend = this.backends.get(input.backend);
    const probe = await backend.preflight();
    if (!probe.available) throw new ServiceError('BACKEND_UNAVAILABLE', probe.reason ?? `${input.backend} backend unavailable`);
    const workspacePath = join(this.instanceRoot, input.instanceId, 'workspace');
    await mkdir(join(this.instanceRoot, input.instanceId), { recursive: true, mode: 0o700 });
    await materializeCfs(tree.path, workspacePath);
    this.repository.createInstance({
      id: input.instanceId,
      kind: input.kind,
      backend: input.backend,
      state: 'PROVISIONING',
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      baseCommit: input.baseCommit,
      workspacePath,
      resourceProfile: input.resourceProfile,
      network: input.network,
    });
    try {
      const handle = await backend.create({
        instanceId: input.instanceId,
        workspacePath,
        resourceProfile: input.resourceProfile,
        network: input.network,
      });
      this.repository.updateInstance(input.instanceId, { state: 'READY', backendHandle: JSON.stringify(handle) });
    } catch (error) {
      this.repository.updateInstance(input.instanceId, {
        state: 'FAILED',
        lastError: error instanceof Error ? error.message : String(error),
      });
      await rm(join(this.instanceRoot, input.instanceId), { recursive: true, force: true });
      throw error;
    }
    const record = this.repository.getInstance(input.instanceId);
    if (!record) throw new ServiceError('BACKEND_ERROR', 'Runtime record disappeared after creation');
    return this.instanceView(record);
  }

  private instanceView(row: InstanceRecord): InstanceView {
    return {
      instantId: row.id,
      kind: row.kind,
      backend: row.backend,
      nodeId: 'local',
      state: row.state,
      baseCommit: row.baseCommit,
      ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
      network: row.network,
      resourceProfile: row.resourceProfile,
    };
  }

  getTurnHandle(instanceId: string): { instance: InstanceRecord; handle: BackendHandle } {
    const instance = this.repository.getInstance(instanceId);
    if (!instance || !instance.backendHandle) throw new ServiceError('NOT_FOUND', 'Turn runtime is unavailable');
    if (!['READY', 'RUNNING'].includes(instance.state)) throw new ServiceError('INSTANCE_BUSY', `Turn runtime is ${instance.state}`);
    return { instance, handle: JSON.parse(instance.backendHandle) as BackendHandle };
  }

  setInstanceState(id: string, state: InstanceState): void {
    this.repository.updateInstance(id, { state });
  }

  async commitTurnRuntime(input: {
    threadId: string;
    turnId: string;
    instanceId: string;
    workspaceId: string;
    ref: 'main';
    expectedHead: Digest;
    operationId: string;
  }): Promise<TurnCommitResult> {
    const record = this.repository.getInstance(input.instanceId);
    if (!record || !record.backendHandle) throw new ServiceError('NOT_FOUND', 'Turn runtime not found');
    if (record.kind !== 'durable' || record.workspaceId !== input.workspaceId || record.baseCommit !== input.expectedHead) {
      throw new ServiceError('INVALID_ARGUMENT', 'Turn runtime binding does not match commit request');
    }
    if (record.state === 'RUNNING') throw new ServiceError('INSTANCE_BUSY', 'Turn runtime has running sessions');
    if (record.state !== 'READY') throw new ServiceError('INSTANCE_BUSY', `Turn runtime is ${record.state}`);
    if (!this.repository.getRef(input.workspaceId, input.ref)) throw new ServiceError('NOT_FOUND', 'Thread workspace ref not found');
    this.repository.beginHarnessOperation(input.operationId, 'commit_turn_runtime', input.operationId);
    this.repository.updateInstance(input.instanceId, { state: 'COMMITTING' });
    try {
      const backend = this.backends.get(record.backend);
      const snapshot = await backend.snapshot(JSON.parse(record.backendHandle) as BackendHandle, join(this.dataDir, 'staging'));
      let tree;
      if (snapshot.cfsPath) {
        try {
          tree = await ingestCfs(snapshot.cfsPath, this.treeRoot, snapshot.treeDigest);
        } finally {
          await rm(snapshot.cfsPath, { force: true });
        }
      } else {
        tree = await exportCfs(snapshot.workspacePath, this.treeRoot);
      }
      const newCommit = commitDigest(EMPTY_CONTRACT_DIGEST, tree.treeDigest, input.expectedHead);
      const response = {
        threadId: input.threadId,
        turnId: input.turnId,
        mode: 'durable' as const,
        state: 'FINISHED' as const,
        instanceId: input.instanceId,
        workspaceId: input.workspaceId,
        headCommit: newCommit,
        commitId: newCommit,
        treeDigest: tree.treeDigest,
        ref: input.ref,
      };
      const updated = this.repository.publishTurnCommit({
        operationId: input.operationId,
        threadId: input.threadId,
        turnId: input.turnId,
        instanceId: input.instanceId,
        workspaceId: input.workspaceId,
        ref: input.ref,
        expectedHead: input.expectedHead,
        tree: { digest: tree.treeDigest, path: tree.path, sizeBytes: tree.sizeBytes },
        commit: { id: newCommit, contractDigest: EMPTY_CONTRACT_DIGEST, parentId: input.expectedHead },
        response,
      });
      if (!updated) {
        const latest = this.repository.getRef(input.workspaceId, input.ref);
        throw new ServiceError('HEAD_CONFLICT', 'Thread workspace ref changed', {
          capturedCommit: newCommit,
          currentHead: latest?.headCommit,
        });
      }
      return {
        commitId: newCommit,
        treeDigest: tree.treeDigest,
        workspaceId: input.workspaceId,
        ref: input.ref,
        headCommit: newCommit,
      };
    } catch (error) {
      this.repository.failOperation(input.operationId, error);
      const latest = this.repository.getInstance(input.instanceId);
      if (latest?.state === 'COMMITTING') this.repository.updateInstance(input.instanceId, { state: 'READY' });
      throw error;
    }
  }

  async deleteTurnRuntime(instanceId: string): Promise<void> {
    const record = this.repository.getInstance(instanceId);
    if (!record || record.state === 'TERMINATED') return;
    this.repository.updateInstance(instanceId, { state: 'TERMINATING' });
    if (record.backendHandle) await this.backends.get(record.backend).destroy(JSON.parse(record.backendHandle) as BackendHandle);
    await rm(join(this.instanceRoot, instanceId), { recursive: true, force: true });
    this.repository.updateInstance(instanceId, { state: 'TERMINATED', backendHandle: null });
  }

  async close(): Promise<void> {
    for (const instance of this.repository.listInstances(['PROVISIONING', 'READY', 'RUNNING', 'COMMITTING', 'TERMINATING'])) {
      if (instance.backendHandle) {
        await this.backends.get(instance.backend).destroy(JSON.parse(instance.backendHandle) as BackendHandle).catch(() => undefined);
      }
      this.repository.updateInstance(instance.id, { state: 'TERMINATED', backendHandle: null });
    }
  }
}
