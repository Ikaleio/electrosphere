import { ServiceError } from './errors.ts';
import type { ExecutionHandle, ExecutionResult } from '../backends/types.ts';
import type { SandboxService } from './sandbox-service.ts';
import type { ShellResult } from './types.ts';

interface Session {
  id: string;
  instanceId: string;
  execution: ExecutionHandle;
  cwd: string;
  tty: boolean;
  cursor: number;
  lastUsedAt: number;
  expiresAt: number;
  active: boolean;
  tail: Promise<void>;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly closingInstances = new Set<string>();
  private readonly cleanupTimer: NodeJS.Timeout;
  private readonly ttlMs = 30 * 60_000;

  constructor(
    private readonly service: SandboxService,
    private readonly maxOutputBytes: number,
  ) {
    this.cleanupTimer = setInterval(() => void this.reapExpired(), 60_000);
    this.cleanupTimer.unref();
  }

  private async reapExpired(): Promise<void> {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt > now) continue;
      if (session.active) await this.service.backends.get(session.execution.backend).kill(session.execution).catch(() => undefined);
      session.active = false;
      this.sessions.delete(id);
    }
  }


  private reap(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (!session.active && session.expiresAt <= now) this.sessions.delete(id);
    }
    if (this.sessions.size < 64) return;
    const removable = [...this.sessions.values()].filter((session) => !session.active).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    while (this.sessions.size >= 64 && removable.length > 0) {
      const session = removable.shift();
      if (session) this.sessions.delete(session.id);
    }
  }

  private requireSession(id: string, instanceId: string): Session {
    const session = this.sessions.get(id);
    if (!session || session.instanceId !== instanceId || session.expiresAt <= Date.now()) {
      throw new ServiceError('NOT_FOUND', 'Session is unavailable');
    }
    return session;
  }

  private async serial<T>(session: Session, action: () => Promise<T>): Promise<T> {
    const prior = session.tail;
    let release!: () => void;
    session.tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      session.lastUsedAt = Date.now();
      session.expiresAt = session.lastUsedAt + this.ttlMs;
      return await action();
    } finally {
      release();
    }
  }

  private shapeOutput(bytes: Uint8Array, maxOutputTokens?: number, originalBytes = bytes.byteLength): { output: string; originalTokenCount: number; omitted: number; truncated: boolean } {
    const requestedBytes = maxOutputTokens === undefined ? this.maxOutputBytes : Math.min(this.maxOutputBytes, maxOutputTokens * 4);
    const limit = Math.max(256, requestedBytes);
    const originalTokenCount = Math.ceil(originalBytes / 4);
    if (originalBytes <= limit && bytes.byteLength <= limit) {
      return { output: Buffer.from(bytes).toString('utf8'), originalTokenCount, omitted: 0, truncated: false };
    }
    const side = Math.floor(limit / 2);
    const omitted = Math.max(0, originalBytes - side * 2);
    const output = `${Buffer.from(bytes.subarray(0, side)).toString('utf8')}\n... ${omitted} bytes omitted ...\n${Buffer.from(bytes.subarray(Math.max(side, bytes.byteLength - side))).toString('utf8')}`;
    return { output, originalTokenCount, omitted, truncated: true };
  }

  private response(session: Session, result: ExecutionResult, maxOutputTokens?: number, killed = false): ShellResult {
    const originalBytes = result.originalBytes ?? result.output.byteLength;
    const backendTruncated = (result.outputOmittedBytes ?? 0) > 0;
    const delta = backendTruncated ? result.output : result.output.subarray(session.cursor);
    const deltaOriginalBytes = backendTruncated ? originalBytes : Math.max(0, originalBytes - session.cursor);
    session.cursor = originalBytes;
    const shaped = this.shapeOutput(delta, maxOutputTokens, deltaOriginalBytes);
    const status = killed
      ? 'killed'
      : result.state === 'RUNNING'
        ? 'running'
        : result.state === 'COMPLETED'
          ? 'completed'
          : result.state === 'TIMED_OUT'
            ? 'timed_out'
            : result.state === 'CANCELED'
              ? 'canceled'
              : 'failed';
    if (result.state !== 'RUNNING') session.active = false;
    return {
      status,
      ...(result.state === 'RUNNING' ? { session_id: session.id } : {}),
      ...(result.exitCode !== undefined ? { exit_code: result.exitCode } : {}),
      output: shaped.output,
      wall_time_ms: (result.finishedAt ?? Date.now()) - result.startedAt,
      original_token_count: shaped.originalTokenCount,
      output_omitted_bytes: shaped.omitted,
      truncated: shaped.truncated,
      chunk_id: crypto.randomUUID(),
    };
  }

  private pollBackend(session: Session, yieldTimeMs: number) {
    const { instance } = this.service.getTurnHandle(session.instanceId);
    return this.service.backends.get(instance.backend).poll(session.execution, { yieldTimeMs });
  }

  private async abandon(session: Session): Promise<void> {
    await this.service.backends.get(session.execution.backend).kill(session.execution).catch(() => undefined);
    session.active = false;
    this.service.setInstanceState(session.instanceId, 'READY');
  }

  async exec(input: {
    instanceId: string;
    command: string;
    workdir?: string;
    tty?: boolean;
    yieldTimeMs: number;
    timeoutMs: number;
    maxOutputTokens?: number;
  }): Promise<ShellResult> {
    this.reap();
    if (this.closingInstances.has(input.instanceId)) throw new ServiceError('TURN_CLOSED', 'Turn runtime is closing');
    if (this.sessions.size >= 64) throw new ServiceError('SESSION_CAPACITY', 'No session capacity is available');
    if (input.command.length === 0 || Buffer.byteLength(input.command) > 128 * 1024) throw new ServiceError('INVALID_ARGUMENT', 'Command is empty or too large');
    const cwd = input.workdir ?? '/workspace';
    if (cwd !== '/workspace' && !cwd.startsWith('/workspace/')) throw new ServiceError('INVALID_ARGUMENT', 'workdir must be inside /workspace');
    const { instance, handle } = this.service.getTurnHandle(input.instanceId);
    const executionId = crypto.randomUUID();
    const execution = await this.service.backends.get(instance.backend).exec(handle, {
      executionId,
      command: input.command,
      cwd,
      env: { HOME: '/workspace', PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
      tty: input.tty ?? false,
      timeoutMs: input.timeoutMs,
    });
    const session: Session = {
      id: crypto.randomUUID(),
      instanceId: input.instanceId,
      execution,
      cwd,
      tty: input.tty ?? false,
      cursor: 0,
      lastUsedAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
      active: true,
      tail: Promise.resolve(),
    };
    this.sessions.set(session.id, session);
    this.service.setInstanceState(input.instanceId, 'RUNNING');
    try {
      const result = await this.pollBackend(session, input.yieldTimeMs);
      const response = this.response(session, result, input.maxOutputTokens);
      if (!session.active) this.service.setInstanceState(input.instanceId, 'READY');
      return response;
    } catch (error) {
      await this.abandon(session);
      throw error;
    }
  }

  async poll(input: { instanceId: string; sessionId: string; yieldTimeMs: number; maxOutputTokens?: number }): Promise<ShellResult> {
    const session = this.requireSession(input.sessionId, input.instanceId);
    return this.serial(session, async () => {
      try {
        const result = await this.pollBackend(session, input.yieldTimeMs);
        const response = this.response(session, result, input.maxOutputTokens);
        if (!session.active) this.service.setInstanceState(session.instanceId, 'READY');
        return response;
      } catch (error) {
        await this.abandon(session);
        throw error;
      }
    });
  }

  async write(input: { instanceId: string; sessionId: string; chars: string; yieldTimeMs: number; maxOutputTokens?: number }): Promise<ShellResult> {
    const session = this.requireSession(input.sessionId, input.instanceId);
    if (this.closingInstances.has(session.instanceId)) throw new ServiceError('TURN_CLOSED', 'Turn runtime is closing');
    return this.serial(session, async () => {
      try {
        if (!session.tty) {
          if (input.chars === '\u0003') {
            await this.service.backends.get(session.execution.backend).kill(session.execution);
          } else {
            throw new ServiceError('SESSION_STDIN_CLOSED', 'Non-TTY session stdin is closed');
          }
        } else {
          await this.service.backends.get(session.execution.backend).write(session.execution, input.chars);
        }
        const result = await this.pollBackend(session, input.yieldTimeMs);
        const response = this.response(session, result, input.maxOutputTokens);
        if (!session.active) this.service.setInstanceState(session.instanceId, 'READY');
        return response;
      } catch (error) {
        if (error instanceof ServiceError && error.code === 'SESSION_STDIN_CLOSED') throw error;
        await this.abandon(session);
        throw error;
      }
    });
  }

  async kill(input: { instanceId: string; sessionId: string }): Promise<ShellResult> {
    const session = this.requireSession(input.sessionId, input.instanceId);
    return this.serial(session, async () => {
      await this.service.backends.get(session.execution.backend).kill(session.execution);
      const result = await this.pollBackend(session, 0);
      session.active = false;
      this.service.setInstanceState(session.instanceId, 'READY');
      return this.response(session, result, undefined, true);
    });
  }

  async closeInstance(instanceId: string): Promise<void> {
    this.closingInstances.add(instanceId);
    const sessions = [...this.sessions.values()].filter((session) => session.instanceId === instanceId && session.active);
    const failures: unknown[] = [];
    for (const session of sessions) {
      try {
        await this.serial(session, async () => {
          await this.service.backends.get(session.execution.backend).kill(session.execution);
          let result = await this.pollBackend(session, 1_000);
          if (result.state === 'RUNNING') {
            await this.service.backends.get(session.execution.backend).kill(session.execution);
            result = await this.pollBackend(session, 1_000);
          }
          if (result.state === 'RUNNING') throw new ServiceError('BACKEND_ERROR', 'Session did not reach a terminal state');
          session.active = false;
        });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, `Failed to close sessions for instance ${instanceId}`);
    const record = this.service.repository.getInstance(instanceId);
    if (record && record.state === 'RUNNING') this.service.setInstanceState(instanceId, 'READY');
  }

  async close(): Promise<void> {
    clearInterval(this.cleanupTimer);
    for (const session of this.sessions.values()) {
      if (session.active) await this.service.backends.get(session.execution.backend).kill(session.execution).catch(() => undefined);
      session.active = false;
    }
    this.sessions.clear();
    this.closingInstances.clear();
  }
}
