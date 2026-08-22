import { FakeFileClient } from './fake-files.ts';
import type {
  BackendHandle,
  CreateInstanceInput,
  ExecInput,
  ExecutionHandle,
  ExecutionResult,
  FileEditInput,
  FileEditResult,
  FileGlobInput,
  FileGlobResult,
  FileGrepInput,
  FileGrepResult,
  FileMoveInput,
  FileMoveResult,
  FileReadBytesInput,
  FileReadBytesResult,
  FileReadInput,
  FileReadResult,
  FileRemoveInput,
  FileStatInput,
  FileStatResult,
  FileWriteInput,
  FileWriteResult,
  HostProbe,
  InstantBackend,
  PollInput,
  SnapshotResult,
} from '../src/backends/types.ts';
import type { Backend } from '../src/domain/types.ts';

interface FakeExecution {
  instanceId: string;
  process: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  output: Buffer[];
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  state: ExecutionResult['state'];
  completion: Promise<void>;
}

export class FakeBackend implements InstantBackend {
  readonly kind: Backend;
  readonly instances = new Map<string, BackendHandle>();
  readonly executions = new Map<string, FakeExecution>();
  createWait?: Promise<void>;
  fileWriteWait?: Promise<void>;
  onCreate?: () => void;
  onFileWrite?: () => void;
  snapshotCount = 0;
  destroyFailures = 0;

  constructor(kind: Backend = 'docker') {
    this.kind = kind;
  }

  async preflight(): Promise<HostProbe> {
    return { nodeId: 'local', available: true };
  }

  async create(input: CreateInstanceInput): Promise<BackendHandle> {
    this.onCreate?.();
    await this.createWait;
    const handle = { backend: this.kind, instanceId: input.instanceId, opaqueId: `fake-${input.instanceId}`, workspacePath: input.workspacePath };
    this.instances.set(input.instanceId, handle);
    return handle;
  }

  private async drain(stream: ReadableStream<Uint8Array>, output: Buffer[]): Promise<void> {
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      output.push(Buffer.from(value));
    }
  }

  async exec(handle: BackendHandle, input: ExecInput): Promise<ExecutionHandle> {
    const process = Bun.spawn(['/usr/bin/setsid', '/bin/sh', '-lc', input.command], {
      cwd: handle.workspacePath,
      env: input.env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output: Buffer[] = [];
    const record: FakeExecution = {
      instanceId: handle.instanceId,
      process,
      output,
      startedAt: Date.now(),
      state: 'RUNNING',
      completion: Promise.resolve(),
    };
    const timeout = input.timeoutMs > 0
      ? setTimeout(() => {
        if (record.state !== 'RUNNING') return;
        process.kill('SIGKILL');
        record.state = 'TIMED_OUT';
      }, input.timeoutMs)
      : undefined;
    timeout?.unref();
    record.completion = Promise.all([
      this.drain(process.stdout, output),
      this.drain(process.stderr, output),
      process.exited,
    ]).then(([, , exitCode]) => {
      if (record.state === 'RUNNING') record.state = exitCode === 0 ? 'COMPLETED' : 'FAILED';
      record.exitCode = exitCode;
      record.finishedAt = Date.now();
      if (timeout) clearTimeout(timeout);
    });
    this.executions.set(input.executionId, record);
    return { backend: this.kind, instanceId: handle.instanceId, executionId: input.executionId, opaqueId: String(process.pid), tty: input.tty };
  }

  async poll(execution: ExecutionHandle, input: PollInput): Promise<ExecutionResult> {
    const record = this.executions.get(execution.executionId);
    if (!record) throw new Error('execution unavailable');
    if (record.state === 'RUNNING') await Promise.race([record.completion, Bun.sleep(input.yieldTimeMs)]);
    return {
      state: record.state,
      ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
      output: Buffer.concat(record.output),
      startedAt: record.startedAt,
      ...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
      originalBytes: Buffer.concat(record.output).length,
      outputOmittedBytes: 0,
    };
  }

  async write(execution: ExecutionHandle, chars: string): Promise<void> {
    const record = this.executions.get(execution.executionId);
    if (!record || record.state !== 'RUNNING') throw new Error('execution unavailable');
    record.process.stdin.write(chars);
  }

  async kill(execution: ExecutionHandle): Promise<void> {
    const record = this.executions.get(execution.executionId);
    if (!record || record.state !== 'RUNNING') return;
    record.state = 'CANCELED';
    try {
      process.kill(-record.process.pid, 'SIGTERM');
    } catch {}
    const terminal = await Promise.race([
      record.completion.then(() => true),
      Bun.sleep(1_000).then(() => false),
    ]);
    if (!terminal) {
      try {
        process.kill(-record.process.pid, 'SIGKILL');
      } catch {}
      await record.completion;
    }
    record.finishedAt ??= Date.now();
  }

  fileRead(handle: BackendHandle, request: FileReadInput): Promise<FileReadResult> {
    return new FakeFileClient(handle).read(request);
  }

  fileReadBytes(handle: BackendHandle, request: FileReadBytesInput): Promise<FileReadBytesResult> {
    return new FakeFileClient(handle).readBytes(request);
  }

  async fileWrite(handle: BackendHandle, request: FileWriteInput): Promise<FileWriteResult> {
    this.onFileWrite?.();
    await this.fileWriteWait;
    return new FakeFileClient(handle).write(request);
  }

  fileEdit(handle: BackendHandle, request: FileEditInput): Promise<FileEditResult> {
    return new FakeFileClient(handle).edit(request);
  }

  fileGlob(handle: BackendHandle, request: FileGlobInput): Promise<FileGlobResult> {
    return new FakeFileClient(handle).glob(request);
  }

  fileGrep(handle: BackendHandle, request: FileGrepInput): Promise<FileGrepResult> {
    return new FakeFileClient(handle).grep(request);
  }

  fileStat(handle: BackendHandle, request: FileStatInput): Promise<FileStatResult> {
    return new FakeFileClient(handle).stat(request);
  }

  fileMove(handle: BackendHandle, request: FileMoveInput): Promise<FileMoveResult> {
    return new FakeFileClient(handle).move(request);
  }

  fileRemove(handle: BackendHandle, request: FileRemoveInput): Promise<void> {
    return new FakeFileClient(handle).remove(request);
  }

  async snapshot(handle: BackendHandle, _destination: string): Promise<SnapshotResult> {
    this.snapshotCount += 1;
    return { workspacePath: handle.workspacePath };
  }

  async destroy(handle: BackendHandle): Promise<void> {
    if (this.destroyFailures > 0) {
      this.destroyFailures -= 1;
      throw new Error('injected destroy failure');
    }
    for (const execution of this.executions.values()) {
      if (execution.instanceId === handle.instanceId && execution.state === 'RUNNING') execution.process.kill('SIGKILL');
    }
    this.instances.delete(handle.instanceId);
  }
}
