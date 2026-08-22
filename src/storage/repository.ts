import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import type { Backend, Digest, InstanceState, NetworkProfile, ResourceProfile, SandboxKind } from '../domain/types.ts';
import { ServiceError } from '../domain/errors.ts';
import type { NewTurnRecord, TurnRecord, TurnState, TurnUpdate } from '../domain/turn-service.ts';
import * as schema from './schema.ts';

export type Db = BunSQLiteDatabase<typeof schema>;

export interface InstanceRecord {
  kind: SandboxKind;
  id: string;
  backend: Backend;
  state: InstanceState;
  workspaceId: string | null;
  baseCommit: Digest;
  backendHandle: string | null;
  workspacePath: string;
  resourceProfile: ResourceProfile;
  network: NetworkProfile;
}

export class Repository {
  constructor(readonly db: Db) {}

  transaction<T>(fn: (tx: Db) => T): T {
    return this.db.transaction((tx) => fn(tx as Db));
  }

  getOperation<T>(kind: string, clientRequestId: string): T | undefined {
    const row = this.db.select().from(schema.operations).where(and(
      eq(schema.operations.operationKind, kind),
      eq(schema.operations.clientRequestId, clientRequestId),
    )).get();
    if (row?.status === 'SUCCEEDED' && row.responseJson) return JSON.parse(row.responseJson) as T;
    if (row?.status === 'FAILED' && row.errorJson) {
      const error = JSON.parse(row.errorJson) as { code: ConstructorParameters<typeof ServiceError>[0]; message: string; details?: unknown };
      throw new ServiceError(error.code, error.message, error.details);
    }
    if (row) throw new ServiceError('INSTANCE_BUSY', 'Operation is already in progress');
    return undefined;
  }


  failOperation(id: string, error: unknown): void {
    const serviceError = error instanceof ServiceError ? error : new ServiceError('BACKEND_ERROR', error instanceof Error ? error.message : String(error));
    this.db.update(schema.operations).set({
      status: 'FAILED',
      errorJson: JSON.stringify({ code: serviceError.code, message: serviceError.message, details: serviceError.details }),
      updatedAt: Date.now(),
      leaseExpiresAt: null,
    }).where(eq(schema.operations.id, id)).run();
  }

  beginHarnessOperation(id: string, kind: string, clientRequestId: string): void {
    this.db.insert(schema.operations).values({
      id,
      operationKind: kind,
      clientRequestId,
      status: 'RUNNING',
      leaseExpiresAt: Date.now() + 300_000,
    }).run();
  }

  putCommit(input: { id: Digest; treeDigest: Digest; contractDigest: Digest; parentId?: Digest }): void {
    this.db.insert(schema.commits).values({
      id: input.id,
      treeDigest: input.treeDigest,
      contractDigest: input.contractDigest,
      parentId: input.parentId ?? null,
    }).onConflictDoNothing().run();
  }

  putTreeObject(input: { digest: Digest; path: string; sizeBytes: number }): void {
    this.db.insert(schema.treeObjects).values(input).onConflictDoNothing().run();
  }

  getCommit(id: Digest) {
    return this.db.select().from(schema.commits).where(eq(schema.commits.id, id)).get();
  }

  getTreeObject(digest: Digest) {
    return this.db.select().from(schema.treeObjects).where(eq(schema.treeObjects.digest, digest)).get();
  }


  loadWorkspaceRefs(id: string) {
    const workspace = this.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, id)).get();
    if (!workspace) return undefined;
    const refs = this.db.select().from(schema.refs).where(eq(schema.refs.workspaceId, id)).all();
    return { workspace, refs };
  }

  getRef(workspaceId: string, name: string) {
    return this.db.select().from(schema.refs).where(and(eq(schema.refs.workspaceId, workspaceId), eq(schema.refs.name, name))).get();
  }


  getThreadWorkspace(threadId: string): { threadId: string; workspaceId: string } | undefined {
    return this.db.select({
      threadId: schema.threadWorkspaces.threadId,
      workspaceId: schema.threadWorkspaces.workspaceId,
    }).from(schema.threadWorkspaces).where(eq(schema.threadWorkspaces.threadId, threadId)).get();
  }

  createThreadWorkspace(input: { threadId: string; workspaceId: string; headCommit: Digest }): void {
    this.transaction((tx) => {
      tx.insert(schema.workspaces).values({ id: input.workspaceId }).run();
      tx.insert(schema.refs).values({ workspaceId: input.workspaceId, name: 'main', headCommit: input.headCommit }).run();
      tx.insert(schema.threadWorkspaces).values({ threadId: input.threadId, workspaceId: input.workspaceId }).run();
    });
  }

  createThreadFork(input: { sourceWorkspaceId: string; destinationThreadId: string; destinationWorkspaceId: string; headCommit: Digest }): void {
    this.transaction((tx) => {
      const source = tx.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.id, input.sourceWorkspaceId)).get();
      if (!source) throw new ServiceError('NOT_FOUND', 'Source thread workspace not found');
      tx.insert(schema.workspaces).values({ id: input.destinationWorkspaceId }).run();
      tx.insert(schema.refs).values({ workspaceId: input.destinationWorkspaceId, name: 'main', headCommit: input.headCommit }).run();
      tx.insert(schema.threadWorkspaces).values({ threadId: input.destinationThreadId, workspaceId: input.destinationWorkspaceId }).run();
    });
  }

  private turnRecord(row: typeof schema.turns.$inferSelect): TurnRecord {
    return {
      threadId: row.threadId,
      turnId: row.turnId,
      mode: row.mode as TurnRecord['mode'],
      state: row.state as TurnState,
      ...(row.instanceId ? { instanceId: row.instanceId } : {}),
      ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
      ...(row.expectedHead ? { expectedHead: row.expectedHead as Digest } : {}),
      requestJson: row.requestJson,
      ...(row.resultJson ? { resultJson: row.resultJson } : {}),
      ...(row.errorJson ? { errorJson: row.errorJson } : {}),
      createdAt: row.createdAt,
      ...(row.finishedAt !== null ? { finishedAt: row.finishedAt } : {}),
    };
  }

  getTurn(threadId: string, turnId: string): TurnRecord | undefined {
    const row = this.db.select().from(schema.turns).where(and(
      eq(schema.turns.threadId, threadId),
      eq(schema.turns.turnId, turnId),
    )).get();
    return row ? this.turnRecord(row) : undefined;
  }

  getOpenTurn(threadId: string): TurnRecord | undefined {
    const row = this.db.select().from(schema.turns).where(and(
      eq(schema.turns.threadId, threadId),
      inArray(schema.turns.state, ['STARTING', 'OPEN', 'FINISHING']),
    )).get();
    return row ? this.turnRecord(row) : undefined;
  }

  createTurn(record: NewTurnRecord): void {
    this.db.insert(schema.turns).values(record).run();
  }

  listTurns(states?: TurnState[]): TurnRecord[] {
    const rows = states && states.length > 0
      ? this.db.select().from(schema.turns).where(inArray(schema.turns.state, states)).orderBy(asc(schema.turns.threadId), asc(schema.turns.turnId)).all()
      : this.db.select().from(schema.turns).orderBy(asc(schema.turns.threadId), asc(schema.turns.turnId)).all();
    return rows.map((row) => this.turnRecord(row));
  }

  updateTurn(threadId: string, turnId: string, update: TurnUpdate): void {
    this.db.update(schema.turns).set(update).where(and(
      eq(schema.turns.threadId, threadId),
      eq(schema.turns.turnId, turnId),
    )).run();
  }

  commitBelongsToHistory(head: Digest, candidate: Digest): boolean {
    let current: string | null = head;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      if (current === candidate) return true;
      visited.add(current);
      current = this.db.select({ parentId: schema.commits.parentId }).from(schema.commits).where(eq(schema.commits.id, current)).get()?.parentId ?? null;
    }
    return false;
  }

  createInstance(input: {
    id: string;
    kind?: SandboxKind;
    backend: Backend;
    state: InstanceState;
    workspaceId?: string;
    baseCommit: Digest;
    workspacePath: string;
    resourceProfile: ResourceProfile;
    network: NetworkProfile;
  }): void {
    this.db.insert(schema.instances).values({
      id: input.id,
      kind: input.kind ?? 'instant',
      backend: input.backend,
      nodeId: 'local',
      state: input.state,
      workspaceId: input.workspaceId ?? null,
      baseCommit: input.baseCommit,
      workspacePath: input.workspacePath,
      resourceProfile: JSON.stringify(input.resourceProfile),
      network: input.network,
    }).run();
  }

  updateInstance(id: string, update: { state?: InstanceState; backendHandle?: string | null; lastError?: string | null }): void {
    this.db.update(schema.instances).set({ ...update, updatedAt: Date.now() }).where(eq(schema.instances.id, id)).run();
  }

  getInstance(id: string): InstanceRecord | undefined {
    const row = this.db.select().from(schema.instances).where(eq(schema.instances.id, id)).get();
    if (!row) return undefined;
    return {
      id: row.id,
      kind: row.kind as SandboxKind,
      backend: row.backend as Backend,
      state: row.state as InstanceState,
      workspaceId: row.workspaceId,
      baseCommit: row.baseCommit as Digest,
      backendHandle: row.backendHandle,
      workspacePath: row.workspacePath,
      resourceProfile: JSON.parse(row.resourceProfile) as ResourceProfile,
      network: row.network as NetworkProfile,
    };
  }

  listInstances(states?: InstanceState[]): InstanceRecord[] {
    const rows = states && states.length > 0
      ? this.db.select().from(schema.instances).where(inArray(schema.instances.state, states)).all()
      : this.db.select().from(schema.instances).all();
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as SandboxKind,
      backend: row.backend as Backend,
      state: row.state as InstanceState,
      workspaceId: row.workspaceId,
      baseCommit: row.baseCommit as Digest,
      backendHandle: row.backendHandle,
      workspacePath: row.workspacePath,
      resourceProfile: JSON.parse(row.resourceProfile) as ResourceProfile,
      network: row.network as NetworkProfile,
    }));
  }


  publishTurnCommit(input: {
    operationId: string;
    threadId: string;
    turnId: string;
    instanceId: string;
    workspaceId: string;
    ref: 'main';
    expectedHead: Digest;
    tree: { digest: Digest; path: string; sizeBytes: number };
    commit: { id: Digest; contractDigest: Digest; parentId: Digest };
    response: unknown;
  }): boolean {
    const conflict = new Error('ref conflict');
    try {
      return this.transaction((tx) => {
        tx.insert(schema.treeObjects).values(input.tree).onConflictDoNothing().run();
        tx.insert(schema.commits).values({
          id: input.commit.id,
          treeDigest: input.tree.digest,
          contractDigest: input.commit.contractDigest,
          parentId: input.commit.parentId,
        }).onConflictDoNothing().run();
        const ref = tx.update(schema.refs).set({ headCommit: input.commit.id, updatedAt: Date.now() }).where(and(
          eq(schema.refs.workspaceId, input.workspaceId),
          eq(schema.refs.name, input.ref),
          eq(schema.refs.headCommit, input.expectedHead),
        )).returning({ headCommit: schema.refs.headCommit }).get();
        if (!ref) throw conflict;
        const turn = tx.update(schema.turns).set({
          state: 'FINISHED',
          resultJson: JSON.stringify(input.response),
          errorJson: null,
          finishedAt: Date.now(),
        }).where(and(
          eq(schema.turns.threadId, input.threadId),
          eq(schema.turns.turnId, input.turnId),
          eq(schema.turns.state, 'FINISHING'),
          eq(schema.turns.instanceId, input.instanceId),
          eq(schema.turns.workspaceId, input.workspaceId),
          eq(schema.turns.expectedHead, input.expectedHead),
        )).returning({ turnId: schema.turns.turnId }).get();
        if (!turn) throw new ServiceError('TURN_CLOSED', 'Turn is not finishing');
        tx.update(schema.instances).set({ state: 'READY', updatedAt: Date.now() }).where(eq(schema.instances.id, input.instanceId)).run();
        tx.update(schema.operations).set({
          status: 'SUCCEEDED',
          responseJson: JSON.stringify(input.response),
          updatedAt: Date.now(),
          leaseExpiresAt: null,
        }).where(eq(schema.operations.id, input.operationId)).run();
        return true;
      });
    } catch (error) {
      if (error === conflict) return false;
      throw error;
    }
  }

  putArtifactAndGrant(input: { threadId: string; digest: Digest; path: string; sizeBytes: number; metadataJson: string }): void {
    this.transaction((tx) => {
      tx.insert(schema.artifacts).values({
        digest: input.digest,
        kind: 'tool',
        path: input.path,
        sizeBytes: input.sizeBytes,
        metadataJson: input.metadataJson,
      }).onConflictDoNothing().run();
      tx.insert(schema.artifactGrants).values({
        threadId: input.threadId,
        digest: input.digest,
      }).onConflictDoNothing().run();
    });
  }

  getGrantedArtifact(threadId: string, digest: Digest): { digest: Digest; path: string; sizeBytes: number; metadataJson: string } | undefined {
    const row = this.db.select({
      digest: schema.artifacts.digest,
      path: schema.artifacts.path,
      sizeBytes: schema.artifacts.sizeBytes,
      metadataJson: schema.artifacts.metadataJson,
    }).from(schema.artifactGrants).innerJoin(
      schema.artifacts,
      eq(schema.artifacts.digest, schema.artifactGrants.digest),
    ).where(and(
      eq(schema.artifactGrants.threadId, threadId),
      eq(schema.artifactGrants.digest, digest),
      eq(schema.artifacts.kind, 'tool'),
    )).get();
    return row ? { ...row, digest: row.digest as Digest } : undefined;
  }

  listGcRoots(): Set<string> {
    const roots = new Set<string>();
    for (const row of this.db.select({ digest: schema.refs.headCommit }).from(schema.refs).all()) roots.add(row.digest);
    for (const row of this.db.select({ digest: schema.instances.baseCommit }).from(schema.instances).where(sql`${schema.instances.state} NOT IN ('TERMINATED','FAILED','LOST')`).all()) roots.add(row.digest);
    return roots;
  }

  listCommits() {
    return this.db.select().from(schema.commits).all();
  }

  listTreeObjects() {
    return this.db.select().from(schema.treeObjects).all();
  }

  deleteTreeObject(digest: Digest): void {
    this.db.delete(schema.treeObjects).where(eq(schema.treeObjects.digest, digest)).run();
  }

  deleteCommit(id: Digest): void {
    this.db.delete(schema.commits).where(eq(schema.commits.id, id)).run();
  }

  deleteRunningOperations(): void {
    this.db.delete(schema.operations).where(eq(schema.operations.status, 'RUNNING')).run();
  }
}
