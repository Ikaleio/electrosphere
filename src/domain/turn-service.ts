import { createHash, randomUUID } from 'node:crypto';
import type { Backend, Digest, NetworkProfile, ResourceProfile } from './types.ts';
import { DEFAULT_RESOURCE_PROFILE } from './types.ts';
import { ServiceError, type ErrorCode } from './errors.ts';
import type { SandboxService, TurnCommitResult } from './sandbox-service.ts';
import type { SessionManager } from './session-manager.ts';
import type { Repository } from '../storage/repository.ts';

export type TurnMode = 'instant' | 'durable';
export type TurnState = 'STARTING' | 'OPEN' | 'FINISHING' | 'FINISHED' | 'FAILED';

export interface TurnView {
  threadId: string;
  turnId: string;
  mode: TurnMode;
  state: TurnState;
  instanceId?: string;
  workspaceId?: string;
  headCommit?: Digest;
}

export interface BoundTurn {
  threadId: string;
  turnId: string;
  mode: TurnMode;
  instanceId: string;
  workspaceId?: string;
  expectedHead?: Digest;
}

export interface TurnLease {
  id: string;
  turn: BoundTurn;
  release(): void;
}

export interface TurnRecord {
  threadId: string;
  turnId: string;
  mode: TurnMode;
  state: TurnState;
  instanceId?: string;
  workspaceId?: string;
  expectedHead?: Digest;
  requestJson: string;
  resultJson?: string;
  errorJson?: string;
  createdAt: number;
  finishedAt?: number;
}

export interface NewTurnRecord {
  threadId: string;
  turnId: string;
  mode: TurnMode;
  state: TurnState;
  requestJson: string;
  workspaceId?: string;
  expectedHead?: Digest;
  createdAt: number;
}

export interface TurnUpdate {
  state?: TurnState;
  instanceId?: string | null;
  workspaceId?: string | null;
  expectedHead?: Digest | null;
  resultJson?: string | null;
  errorJson?: string | null;
  finishedAt?: number | null;
}

export const TURN_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

interface StartTurnInput {
  threadId: string;
  turnId: string;
  mode: TurnMode;
  backend?: Backend;
  network?: NetworkProfile;
  resourceProfile?: ResourceProfile;
}

interface StoredError {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function validateIdentifier(name: string, value: string): void {
  if (!TURN_IDENTIFIER_PATTERN.test(value)) throw new ServiceError('INVALID_ARGUMENT', `${name} is invalid`);
}

function serviceError(error: unknown): ServiceError {
  return error instanceof ServiceError
    ? error
    : new ServiceError('BACKEND_ERROR', error instanceof Error ? error.message : String(error));
}

function serializeError(error: unknown): string {
  const normalized = serviceError(error);
  return JSON.stringify({
    code: normalized.code,
    message: normalized.message,
    ...(normalized.details === undefined ? {} : { details: normalized.details }),
  });
}

function replayError(record: TurnRecord): never {
  if (!record.errorJson) throw new ServiceError('TURN_CLOSED', 'Turn failed without a stored error');
  const error = JSON.parse(record.errorJson) as StoredError;
  throw new ServiceError(error.code, error.message, error.details);
}

function normalizedRequest(input: StartTurnInput): string {
  return JSON.stringify({
    mode: input.mode,
    ...(input.backend ? { backend: input.backend } : {}),
    ...(input.network ? { network: input.network } : {}),
    ...(input.resourceProfile ? {
      resourceProfile: {
        memoryMiB: input.resourceProfile.memoryMiB,
        vcpus: input.resourceProfile.vcpus,
        diskMiB: input.resourceProfile.diskMiB,
        pidsMax: input.resourceProfile.pidsMax,
        timeoutMs: input.resourceProfile.timeoutMs,
      },
    } : {}),
  });
}

export function harnessRequestId(operation: string, ...parts: string[]): string {
  const hash = createHash('sha256');
  hash.update(operation);
  for (const part of parts) {
    hash.update('\u0000');
    hash.update(part);
  }
  return `harness:${operation}:${hash.digest('hex')}`;
}

export class TurnService {
  private readonly activeLeases = new Map<string, BoundTurn>();
  private readonly leaseCounts = new Map<string, number>();
  private readonly leaseWaiters = new Map<string, () => void>();
  private readonly startPromises = new Map<string, Promise<TurnView>>();
  private readonly finishPromises = new Map<string, Promise<TurnView>>();
  private closing = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly repository: Repository,
    private readonly service: SandboxService,
    private readonly sessions: SessionManager,
    private readonly defaultBackend: Backend,
  ) {}

  private view(record: TurnRecord): TurnView {
    let headCommit = record.expectedHead;
    if (record.resultJson) {
      const result = JSON.parse(record.resultJson) as { headCommit?: Digest };
      headCommit = result.headCommit ?? headCommit;
    }
    return {
      threadId: record.threadId,
      turnId: record.turnId,
      mode: record.mode,
      state: record.state,
      ...(record.instanceId ? { instanceId: record.instanceId } : {}),
      ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
      ...(headCommit ? { headCommit } : {}),
    };
  }

  private existingStart(record: TurnRecord, requestJson: string): TurnView {
    if (record.requestJson !== requestJson) throw new ServiceError('INVALID_ARGUMENT', 'Turn ID was already used with a different request');
    if (record.state === 'OPEN') return this.view(record);
    if (record.state === 'FINISHED') return this.view(record);
    if (record.state === 'FAILED') return replayError(record);
    throw new ServiceError('THREAD_BUSY', `Turn is ${record.state}`);
  }

  start(input: StartTurnInput): Promise<TurnView> {
    if (this.closing) return Promise.reject(new ServiceError('TURN_CLOSED', 'Turn service is closing'));
    validateIdentifier('threadId', input.threadId);
    validateIdentifier('turnId', input.turnId);
    const requestJson = normalizedRequest(input);
    const existing = this.repository.getTurn(input.threadId, input.turnId);
    if (existing) {
      try {
        return Promise.resolve(this.existingStart(existing, requestJson));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const open = this.repository.getOpenTurn(input.threadId);
    if (open) return Promise.reject(new ServiceError('THREAD_BUSY', `Thread already has active turn ${open.turnId}`));
    try {
      this.repository.createTurn({
        threadId: input.threadId,
        turnId: input.turnId,
        mode: input.mode,
        state: 'STARTING',
        requestJson,
        createdAt: Date.now(),
      });
    } catch (error) {
      const raced = this.repository.getTurn(input.threadId, input.turnId);
      if (raced) {
        try {
          return Promise.resolve(this.existingStart(raced, requestJson));
        } catch (replayed) {
          return Promise.reject(replayed);
        }
      }
      const active = this.repository.getOpenTurn(input.threadId);
      if (active) return Promise.reject(new ServiceError('THREAD_BUSY', `Thread already has active turn ${active.turnId}`));
      return Promise.reject(error);
    }
    const key = turnKey(input.threadId, input.turnId);
    const started = this.startCreated(input);
    this.startPromises.set(key, started);
    void started.then(
      () => this.startPromises.delete(key),
      () => this.startPromises.delete(key),
    );
    return started;
  }

  private async startCreated(input: StartTurnInput): Promise<TurnView> {
    const instanceId = randomUUID();
    let runtimeCreated = false;
    try {
      if (input.mode === 'instant') {
        await this.service.createTurnRuntime({
          instanceId,
          kind: 'instant',
          baseCommit: this.service.getCanonicalEmptyCommit(),
          backend: input.backend ?? 'firecracker',
          network: input.network ?? 'none',
          resourceProfile: input.resourceProfile ?? DEFAULT_RESOURCE_PROFILE,
        });
        runtimeCreated = true;
        this.repository.updateTurn(input.threadId, input.turnId, { state: 'OPEN', instanceId });
      } else {
        const workspace = await this.service.ensureThreadWorkspace(input.threadId);
        await this.service.createTurnRuntime({
          instanceId,
          kind: 'durable',
          baseCommit: workspace.headCommit,
          workspaceId: workspace.workspaceId,
          backend: input.backend ?? this.defaultBackend,
          network: input.network ?? 'none',
          resourceProfile: input.resourceProfile ?? DEFAULT_RESOURCE_PROFILE,
        });
        runtimeCreated = true;
        this.repository.updateTurn(input.threadId, input.turnId, {
          state: 'OPEN',
          instanceId,
          workspaceId: workspace.workspaceId,
          expectedHead: workspace.headCommit,
        });
      }
      const opened = this.repository.getTurn(input.threadId, input.turnId);
      if (!opened) throw new ServiceError('BACKEND_ERROR', 'Turn record disappeared during start');
      return this.view(opened);
    } catch (error) {
      if (runtimeCreated) await this.service.deleteTurnRuntime(instanceId).catch(() => undefined);
      this.repository.updateTurn(input.threadId, input.turnId, {
        state: 'FAILED',
        instanceId,
        errorJson: serializeError(error),
        finishedAt: Date.now(),
      });
      throw error;
    }
  }

  private bound(record: TurnRecord): BoundTurn {
    if (record.state !== 'OPEN' || !record.instanceId) throw new ServiceError('TURN_CLOSED', 'Turn is not open');
    if (record.mode === 'durable' && (!record.workspaceId || !record.expectedHead)) {
      throw new ServiceError('BACKEND_ERROR', 'Durable turn binding is incomplete');
    }
    return {
      threadId: record.threadId,
      turnId: record.turnId,
      mode: record.mode,
      instanceId: record.instanceId,
      ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
      ...(record.expectedHead ? { expectedHead: record.expectedHead } : {}),
    };
  }

  acquire(threadId: string, turnId: string): TurnLease {
    if (this.closing) throw new ServiceError('TURN_CLOSED', 'Turn service is closing');
    validateIdentifier('threadId', threadId);
    validateIdentifier('turnId', turnId);
    const turn = this.resolve(threadId, turnId);
    const id = randomUUID();
    const key = turnKey(threadId, turnId);
    this.activeLeases.set(id, turn);
    this.leaseCounts.set(key, (this.leaseCounts.get(key) ?? 0) + 1);
    let released = false;
    return {
      id,
      turn,
      release: () => {
        if (released) return;
        released = true;
        if (!this.activeLeases.delete(id)) return;
        const remaining = (this.leaseCounts.get(key) ?? 1) - 1;
        if (remaining > 0) {
          this.leaseCounts.set(key, remaining);
          return;
        }
        this.leaseCounts.delete(key);
        const waiter = this.leaseWaiters.get(key);
        if (waiter) {
          this.leaseWaiters.delete(key);
          waiter();
        }
      },
    };
  }

  resolve(threadId: string, turnId: string): BoundTurn {
    const record = this.repository.getTurn(threadId, turnId);
    if (!record) throw new ServiceError('TURN_CLOSED', 'Turn does not exist');
    return this.bound(record);
  }

  resolveLease(leaseId: string): BoundTurn | undefined {
    return this.activeLeases.get(leaseId);
  }

  private waitForLeases(threadId: string, turnId: string): Promise<void> {
    const key = turnKey(threadId, turnId);
    if ((this.leaseCounts.get(key) ?? 0) === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.leaseWaiters.set(key, resolve));
  }

  finish(input: { threadId: string; turnId: string }): Promise<TurnView> {
    validateIdentifier('threadId', input.threadId);
    validateIdentifier('turnId', input.turnId);
    const record = this.repository.getTurn(input.threadId, input.turnId);
    if (!record) return Promise.reject(new ServiceError('TURN_CLOSED', 'Turn does not exist'));
    if (record.state === 'FINISHED') return Promise.resolve(this.view(record));
    if (record.state === 'FAILED') {
      try {
        return Promise.resolve(replayError(record));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (record.state !== 'OPEN') return Promise.reject(new ServiceError('THREAD_BUSY', `Turn is ${record.state}`));
    const key = turnKey(input.threadId, input.turnId);
    if (this.finishPromises.has(key)) return Promise.reject(new ServiceError('THREAD_BUSY', 'Turn is already finishing'));
    this.repository.updateTurn(input.threadId, input.turnId, { state: 'FINISHING' });
    const finished = this.finishOpen({ ...record, state: 'FINISHING' });
    this.finishPromises.set(key, finished);
    void finished.then(
      () => this.finishPromises.delete(key),
      () => this.finishPromises.delete(key),
    );
    return finished;
  }

  private async failTurn(record: TurnRecord, error: unknown): Promise<never> {
    if (record.instanceId) {
      try {
        await this.service.deleteTurnRuntime(record.instanceId);
      } catch (cleanupError) {
        this.repository.updateInstance(record.instanceId, {
          state: 'LOST',
          lastError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
    }
    this.repository.updateTurn(record.threadId, record.turnId, {
      state: 'FAILED',
      errorJson: serializeError(error),
      finishedAt: Date.now(),
    });
    throw error;
  }

  private async finishOpen(record: TurnRecord): Promise<TurnView> {
    await this.waitForLeases(record.threadId, record.turnId);
    if (!record.instanceId) return this.failTurn(record, new ServiceError('BACKEND_ERROR', 'Open turn has no runtime'));
    try {
      await this.sessions.closeInstance(record.instanceId);
    } catch (error) {
      return this.failTurn(record, error);
    }
    if (record.mode === 'instant') {
      try {
        await this.service.deleteTurnRuntime(record.instanceId);
      } catch (error) {
        this.repository.updateInstance(record.instanceId, {
          state: 'LOST',
          lastError: error instanceof Error ? error.message : String(error),
        });
        this.repository.updateTurn(record.threadId, record.turnId, {
          state: 'FAILED',
          errorJson: serializeError(error),
          finishedAt: Date.now(),
        });
        throw error;
      }
      const result: TurnView = {
        threadId: record.threadId,
        turnId: record.turnId,
        mode: 'instant',
        state: 'FINISHED',
        instanceId: record.instanceId,
      };
      this.repository.updateTurn(record.threadId, record.turnId, {
        state: 'FINISHED',
        resultJson: JSON.stringify(result),
        errorJson: null,
        finishedAt: Date.now(),
      });
      return result;
    }
    if (!record.workspaceId || !record.expectedHead) {
      return this.failTurn(record, new ServiceError('BACKEND_ERROR', 'Durable turn binding is incomplete'));
    }
    let committed: TurnCommitResult;
    try {
      committed = await this.service.commitTurnRuntime({
        threadId: record.threadId,
        turnId: record.turnId,
        instanceId: record.instanceId,
        workspaceId: record.workspaceId,
        ref: 'main',
        expectedHead: record.expectedHead,
        operationId: harnessRequestId('finish', record.threadId, record.turnId),
      });
    } catch (error) {
      return this.failTurn(record, error);
    }
    try {
      await this.service.deleteTurnRuntime(record.instanceId);
    } catch (cleanupError) {
      this.repository.updateInstance(record.instanceId, {
        state: 'LOST',
        lastError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
      const stored = this.repository.getTurn(record.threadId, record.turnId);
      const result = stored?.resultJson ? JSON.parse(stored.resultJson) as Record<string, unknown> : {};
      this.repository.updateTurn(record.threadId, record.turnId, {
        resultJson: JSON.stringify({
          ...result,
          cleanup_error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        }),
      });
    }
    const finished = this.repository.getTurn(record.threadId, record.turnId);
    if (!finished) throw new ServiceError('BACKEND_ERROR', 'Turn record disappeared after commit');
    return {
      ...this.view(finished),
      headCommit: committed.headCommit,
    };
  }

  async fork(input: { sourceThreadId: string; destinationThreadId: string; commitId?: Digest }): Promise<{ threadId: string; workspaceId: string; headCommit: Digest }> {
    if (this.closing) throw new ServiceError('TURN_CLOSED', 'Turn service is closing');
    validateIdentifier('sourceThreadId', input.sourceThreadId);
    validateIdentifier('destinationThreadId', input.destinationThreadId);
    if (input.sourceThreadId === input.destinationThreadId) throw new ServiceError('INVALID_ARGUMENT', 'Destination thread must differ from source thread');
    const active = this.repository.getOpenTurn(input.sourceThreadId);
    if (active) throw new ServiceError('THREAD_BUSY', `Source thread has active turn ${active.turnId}`);
    const source = this.repository.getThreadWorkspace(input.sourceThreadId);
    if (!source) throw new ServiceError('NOT_FOUND', 'Source durable thread does not exist');
    if (this.repository.getThreadWorkspace(input.destinationThreadId)) throw new ServiceError('INVALID_ARGUMENT', 'Destination thread already exists');
    const current = this.repository.getRef(source.workspaceId, 'main');
    if (!current) throw new ServiceError('NOT_FOUND', 'Source thread main ref not found');
    const headCommit = input.commitId ?? current.headCommit as Digest;
    if (input.commitId && !this.repository.commitBelongsToHistory(current.headCommit as Digest, input.commitId)) {
      throw new ServiceError('INVALID_ARGUMENT', 'Commit does not belong to source thread history');
    }
    const workspaceId = randomUUID();
    this.repository.createThreadFork({
      sourceWorkspaceId: source.workspaceId,
      destinationThreadId: input.destinationThreadId,
      destinationWorkspaceId: workspaceId,
      headCommit,
    });
    return { threadId: input.destinationThreadId, workspaceId, headCommit };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.closeAll();
    return this.closePromise;
  }

  private async closeAll(): Promise<void> {
    const failures: unknown[] = [];
    const starts = [...this.startPromises.values()];
    if (starts.length > 0) await Promise.allSettled(starts);
    for (const record of this.repository.listTurns(['OPEN'])) {
      try {
        await this.finish({ threadId: record.threadId, turnId: record.turnId });
      } catch (error) {
        failures.push(error);
      }
    }
    const finishes = [...this.finishPromises.values()];
    if (finishes.length > 0) {
      const settled = await Promise.allSettled(finishes);
      for (const result of settled) if (result.status === 'rejected') failures.push(result.reason);
    }
    for (const record of this.repository.listTurns(['STARTING', 'FINISHING'])) {
      try {
        if (record.instanceId) await this.service.deleteTurnRuntime(record.instanceId);
      } catch (error) {
        failures.push(error);
        if (record.instanceId) {
          this.repository.updateInstance(record.instanceId, {
            state: 'LOST',
            lastError: error instanceof Error ? error.message : String(error),
          });
        }
      }
      this.repository.updateTurn(record.threadId, record.turnId, {
        state: 'FAILED',
        errorJson: JSON.stringify({ code: 'TURN_CLOSED', message: 'Turn service closed during active turn' }),
        finishedAt: Date.now(),
      });
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Failed to close all turns');
  }
}
