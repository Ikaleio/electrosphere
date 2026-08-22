import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRequest, AgentResponse } from '../agent-protocol.ts';
import type { Config } from '../daemon/config.ts';
import { ServiceError } from '../domain/errors.ts';
import { isDigest } from '../domain/types.ts';
import { AgentFrameChannel, SocketFrameWriter } from './agent-transport.ts';
import { AgentFileClient } from './agent-files.ts';
import { workspaceTarStream } from '../storage/tar.ts';
import type {
  AgentTransport,
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
} from './types.ts';

interface DockerFetchInit extends RequestInit {
  unix: string;
}


interface AgentSocketState {
  transport: DockerAgentTransport;
}

class DockerAgentTransport implements AgentTransport {
  private socket?: Bun.Socket<AgentSocketState>;
  private channel?: AgentFrameChannel;
  private readonly writer = new SocketFrameWriter();
  private handshake = Buffer.alloc(0);
  private dockerFrames = Buffer.alloc(0);
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readonly ready = new Promise<void>((resolve, reject) => {
    this.readyResolve = resolve;
    this.readyReject = reject;
  });
  private connected = false;
  private closed = false;

  private constructor() {}

  static async connect(dockerSocket: string, containerId: string): Promise<DockerAgentTransport> {
    const transport = new DockerAgentTransport();
    transport.socket = await Bun.connect<AgentSocketState>({
      unix: dockerSocket,
      data: { transport },
      socket: {
        open(socket) {
          transport.writer.attach(socket);
          const request = [
            `POST /v1.47/containers/${containerId}/attach?stream=1&stdin=1&stdout=1&stderr=1 HTTP/1.1`,
            'Host: localhost',
            'Connection: Upgrade',
            'Upgrade: tcp',
            'Content-Length: 0',
            '',
            '',
          ].join('\r\n');
          socket.write(request);
        },
        data(_socket, data) {
          transport.onData(Buffer.from(data));
        },
        drain() {
          transport.writer.drain();
        },
        error(_socket, error) {
          transport.fail(error);
        },
        close() {
          transport.fail(new Error('Docker agent attach stream closed'));
        },
      },
    });
    transport.channel = new AgentFrameChannel(
      (frame) => transport.writer.write(frame),
      () => transport.socket?.end(),
    );
    await transport.ready;
    const probe = await transport.request({ type: 'Poll', executionId: '00000000-0000-0000-0000-000000000000' });
    if (probe.ok || probe.error !== 'execution unavailable') {
      throw new ServiceError('BACKEND_ERROR', probe.error ?? 'Guest agent readiness probe failed');
    }
    return transport;
  }

  private onData(chunk: Buffer): void {
    if (!this.connected) {
      this.handshake = Buffer.concat([this.handshake, chunk]);
      const boundary = this.handshake.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      const header = this.handshake.subarray(0, boundary).toString('latin1');
      if (!/^HTTP\/1\.[01] (101|200)\b/.test(header)) {
        this.fail(new Error(`Docker attach failed: ${header.split('\r\n')[0] ?? header}`));
        return;
      }
      const remainder = this.handshake.subarray(boundary + 4);
      this.handshake = Buffer.alloc(0);
      this.connected = true;
      this.readyResolve();
      if (remainder.length > 0) this.consumeDockerFrames(remainder);
      return;
    }
    this.consumeDockerFrames(chunk);
  }

  private consumeDockerFrames(chunk: Buffer): void {
    this.dockerFrames = Buffer.concat([this.dockerFrames, chunk]);
    while (this.dockerFrames.length >= 8) {
      const stream = this.dockerFrames[0];
      const length = this.dockerFrames.readUInt32BE(4);
      if (this.dockerFrames.length < length + 8) return;
      const payload = this.dockerFrames.subarray(8, length + 8);
      this.dockerFrames = this.dockerFrames.subarray(length + 8);
      if (stream === 1) this.channel?.push(payload);
    }
  }


  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.connected) this.readyReject(error);
    this.channel?.fail(error);
    this.writer.clear();
  }

  async request(request: AgentRequest): Promise<AgentResponse> {
    await this.ready;
    if (this.closed || !this.channel) throw new ServiceError('BACKEND_ERROR', 'Guest agent transport is closed');
    return this.channel.request(request);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel?.close();
    this.writer.clear();
  }
}

interface DockerExecutionRecord {
  transport: DockerAgentTransport;
  startedAt: number;
  state: ExecutionResult['state'];
  exitCode?: number;
  finishedAt?: number;
  output: Buffer;
  originalBytes: number;
  outputOmittedBytes: number;
}

const API = 'http://localhost/v1.47';

export function buildDockerCreateRequest(image: string, input: CreateInstanceInput) {
  return {
    Image: image,
    Entrypoint: ['/usr/local/bin/electrosphere-agent'],
    Cmd: [],
    User: '1000:1000',
    WorkingDir: '/workspace',
    OpenStdin: true,
    StdinOnce: false,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    NetworkDisabled: input.network === 'none',
    Labels: { 'electrosphere.instance': input.instanceId },
    HostConfig: {
      AutoRemove: false,
      ReadonlyRootfs: true,
      NetworkMode: input.network === 'none' ? 'none' : 'bridge',
      Privileged: false,
      PublishAllPorts: false,
      PidMode: '',
      IpcMode: 'private',
      UTSMode: '',
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Devices: [],
      PortBindings: {},
      Tmpfs: {
        '/workspace': `rw,nosuid,nodev,size=${input.resourceProfile.diskMiB * 1024 * 1024},mode=0770,uid=1000,gid=1000`,
        '/tmp': 'rw,noexec,nosuid,nodev,size=67108864,mode=1777',
        '/run': 'rw,noexec,nosuid,nodev,size=16777216,mode=755',
      },
      Memory: input.resourceProfile.memoryMiB * 1024 * 1024,
      MemorySwap: input.resourceProfile.memoryMiB * 1024 * 1024,
      NanoCpus: input.resourceProfile.vcpus * 1_000_000_000,
      PidsLimit: input.resourceProfile.pidsMax,
      Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 1024 }],
    },
  };
}

export class DockerBackend implements InstantBackend {
  readonly kind = 'docker' as const;
  private probe: HostProbe = { nodeId: 'local', available: false, reason: 'preflight not run' };
  private readonly transports = new Map<string, DockerAgentTransport>();
  private readonly executions = new Map<string, DockerExecutionRecord>();

  constructor(private readonly config: Config) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${API}${path}`, { ...init, unix: this.config.dockerSocket } as DockerFetchInit);
    if (!response.ok) {
      const body = await response.text();
      throw new ServiceError('BACKEND_ERROR', `Docker API ${response.status}: ${body}`);
    }
    return response;
  }

  async preflight(): Promise<HostProbe> {
    try {
      await this.request('/_ping');
      const image = this.config.runtimeImage;
      if (!image || (!/@sha256:[0-9a-f]{64}$/.test(image) && !/^sha256:[0-9a-f]{64}$/.test(image))) {
        this.probe = { nodeId: 'local', available: false, reason: 'ELECTROSPHERE_RUNTIME_IMAGE must be an immutable image@sha256 digest or local sha256 image ID' };
        return this.probe;
      }
      const inspected = await this.request(`/images/${encodeURIComponent(image)}/json`);
      const metadata = await inspected.json() as { Config?: { Entrypoint?: string[] } };
      if (metadata.Config?.Entrypoint?.[0] !== '/usr/local/bin/electrosphere-agent') {
        this.probe = { nodeId: 'local', available: false, reason: 'Runtime image does not use the Electrosphere agent as PID 1' };
        return this.probe;
      }
      this.probe = { nodeId: 'local', available: true };
    } catch (error) {
      this.probe = { nodeId: 'local', available: false, reason: error instanceof Error ? error.message : String(error) };
    }
    return this.probe;
  }

  private ensureAvailable(): void {
    if (!this.probe.available) throw new ServiceError('BACKEND_UNAVAILABLE', this.probe.reason ?? 'Docker backend is unavailable');
  }

  private async restoreWorkspace(transport: DockerAgentTransport, workspacePath: string): Promise<void> {
    const staging = join(this.config.dataDir, 'staging');
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const tarPath = join(staging, `${crypto.randomUUID()}.tar`);
    const target = await open(tarPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    let tarBytes = 0;
    try {
      const reader = workspaceTarStream(workspacePath).getReader();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        await target.write(next.value);
        tarBytes += next.value.byteLength;
      }
      await target.sync();
    } finally {
      await target.close();
    }
    const encodedBytes = Math.ceil(tarBytes / 3) * 4;
    const executionId = crypto.randomUUID();
    try {
      const started = await transport.request({
        type: 'Exec',
        executionId,
        command: `head -c ${encodedBytes} | base64 -d | tar -x -C /workspace`,
        cwd: '/workspace',
        env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
        tty: true,
        timeoutMs: 30_000,
      });
      if (!started.ok) throw new ServiceError('BACKEND_ERROR', started.error ?? 'Workspace restore command failed to start');
      const source = await open(tarPath, constants.O_RDONLY);
      try {
        const buffer = Buffer.allocUnsafe(192 * 1024);
        let offset = 0;
        while (offset < tarBytes) {
          const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, tarBytes - offset), offset);
          if (bytesRead === 0) break;
          const written = await transport.request({ type: 'Write', executionId, chars: buffer.subarray(0, bytesRead).toString('base64') });
          if (!written.ok) throw new ServiceError('BACKEND_ERROR', written.error ?? 'Workspace restore write failed');
          offset += bytesRead;
        }
        if (offset !== tarBytes) throw new ServiceError('BACKEND_ERROR', 'Workspace restore archive changed while reading');
      } finally {
        await source.close();
      }
      const deadline = Date.now() + 30_000;
      while (true) {
        const polled = await transport.request({ type: 'Poll', executionId });
        if (!polled.ok) throw new ServiceError('BACKEND_ERROR', polled.error ?? 'Workspace restore poll failed');
        if (polled.state !== 'RUNNING') {
          if (polled.state !== 'COMPLETED' || polled.exitCode !== 0) throw new ServiceError('BACKEND_ERROR', polled.output ?? 'Workspace restore failed');
          break;
        }
        if (Date.now() >= deadline) throw new ServiceError('BACKEND_ERROR', 'Workspace restore timed out');
        await Bun.sleep(10);
      }
    } finally {
      await rm(tarPath, { force: true });
    }
  }

  async create(input: CreateInstanceInput): Promise<BackendHandle> {
    this.ensureAvailable();
    if (input.network === 'egress') throw new ServiceError('BACKEND_UNAVAILABLE', 'Docker egress requires an installed host egress policy');
    const image = this.config.runtimeImage;
    if (!image) throw new ServiceError('BACKEND_UNAVAILABLE', 'Runtime image is not configured');
    const created = await this.request(`/containers/create?name=electrosphere-${input.instanceId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildDockerCreateRequest(image, input)),
    });
    const result = await created.json() as { Id: string };
    try {
      await this.request(`/containers/${result.Id}/start`, { method: 'POST' });
      const transport = await DockerAgentTransport.connect(this.config.dockerSocket, result.Id);
      await this.restoreWorkspace(transport, input.workspacePath);
      this.transports.set(result.Id, transport);
      return { backend: 'docker', instanceId: input.instanceId, opaqueId: result.Id, workspacePath: input.workspacePath };
    } catch (error) {
      await this.request(`/containers/${result.Id}?force=true&v=true`, { method: 'DELETE' }).catch(() => undefined);
      throw error;
    }
  }

  private transport(handle: BackendHandle): DockerAgentTransport {
    const transport = this.transports.get(handle.opaqueId);
    if (!transport) throw new ServiceError('BACKEND_ERROR', 'Guest agent transport is unavailable');
    return transport;
  }

  private fileTransport(handle: BackendHandle): AgentFileClient {
    const transport = this.transports.get(handle.opaqueId);
    if (!transport) throw new ServiceError('NOT_FOUND', 'Docker turn runtime is unavailable');
    return new AgentFileClient(transport);
  }

  async exec(handle: BackendHandle, input: ExecInput): Promise<ExecutionHandle> {
    const transport = this.transport(handle);
    const response = await transport.request({
      type: 'Exec',
      executionId: input.executionId,
      command: input.command,
      cwd: input.cwd,
      env: input.env,
      tty: input.tty,
      timeoutMs: input.timeoutMs,
    });
    if (!response.ok) throw new ServiceError('BACKEND_ERROR', response.error ?? 'Guest agent rejected execution');
    this.executions.set(input.executionId, {
      transport,
      startedAt: Date.now(),
      state: 'RUNNING',
      output: Buffer.alloc(0),
      originalBytes: 0,
      outputOmittedBytes: 0,
    });
    return { backend: 'docker', instanceId: handle.instanceId, executionId: input.executionId, opaqueId: input.executionId, tty: input.tty };
  }

  async poll(execution: ExecutionHandle, input: PollInput): Promise<ExecutionResult> {
    const record = this.executions.get(execution.executionId);
    if (!record) throw new ServiceError('NOT_FOUND', 'Execution is unavailable');
    const deadline = Date.now() + input.yieldTimeMs;
    do {
      const response = await record.transport.request({ type: 'Poll', executionId: execution.executionId });
      if (response.errorCode === 'STORAGE_EXHAUSTED') throw new ServiceError('STORAGE_EXHAUSTED', response.error ?? 'Workspace disk is full');
      if (!response.ok) throw new ServiceError('BACKEND_ERROR', response.error ?? 'Guest agent poll failed');
      record.state = (response.state ?? 'LOST') as ExecutionResult['state'];
      record.output = Buffer.from(response.output ?? '', 'utf8');
      record.originalBytes = response.originalBytes ?? record.output.length;
      record.outputOmittedBytes = response.outputOmittedBytes ?? Math.max(0, record.originalBytes - record.output.length);
      if (response.exitCode !== undefined) record.exitCode = response.exitCode;
      if (record.state !== 'RUNNING') {
        record.finishedAt = Date.now();
        break;
      }
      if (Date.now() >= deadline) break;
      await Bun.sleep(Math.min(25, Math.max(0, deadline - Date.now())));
    } while (true);
    return {
      state: record.state,
      ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
      output: record.output,
      startedAt: record.startedAt,
      ...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
      originalBytes: record.originalBytes,
      outputOmittedBytes: record.outputOmittedBytes,
    };
  }

  async write(execution: ExecutionHandle, chars: string): Promise<void> {
    const record = this.executions.get(execution.executionId);
    if (!record) throw new ServiceError('NOT_FOUND', 'Execution is unavailable');
    const response = await record.transport.request({ type: 'Write', executionId: execution.executionId, chars });
    if (!response.ok) throw new ServiceError('BACKEND_ERROR', response.error ?? 'Guest agent write failed');
  }

  async kill(execution: ExecutionHandle): Promise<void> {
    const record = this.executions.get(execution.executionId);
    if (!record || record.state !== 'RUNNING') return;
    const response = await record.transport.request({ type: 'Kill', executionId: execution.executionId, graceMs: 1_000 });
    if (!response.ok) throw new ServiceError('BACKEND_ERROR', response.error ?? 'Guest agent kill failed');
    record.state = 'CANCELED';
    record.finishedAt = Date.now();
  }

  fileRead(handle: BackendHandle, request: FileReadInput): Promise<FileReadResult> {
    return this.fileTransport(handle).read(request);
  }

  fileReadBytes(handle: BackendHandle, request: FileReadBytesInput): Promise<FileReadBytesResult> {
    return this.fileTransport(handle).readBytes(request);
  }

  fileWrite(handle: BackendHandle, request: FileWriteInput): Promise<FileWriteResult> {
    return this.fileTransport(handle).write(request);
  }

  fileEdit(handle: BackendHandle, request: FileEditInput): Promise<FileEditResult> {
    return this.fileTransport(handle).edit(request);
  }

  fileGlob(handle: BackendHandle, request: FileGlobInput): Promise<FileGlobResult> {
    return this.fileTransport(handle).glob(request);
  }

  fileGrep(handle: BackendHandle, request: FileGrepInput): Promise<FileGrepResult> {
    return this.fileTransport(handle).grep(request);
  }

  fileStat(handle: BackendHandle, request: FileStatInput): Promise<FileStatResult> {
    return this.fileTransport(handle).stat(request);
  }

  fileMove(handle: BackendHandle, request: FileMoveInput): Promise<FileMoveResult> {
    return this.fileTransport(handle).move(request);
  }

  fileRemove(handle: BackendHandle, request: FileRemoveInput): Promise<void> {
    return this.fileTransport(handle).remove(request);
  }

  async snapshot(handle: BackendHandle, destination: string): Promise<SnapshotResult> {
    const transport = this.transport(handle);
    const snapshotId = crypto.randomUUID();
    const path = join(destination, `${handle.instanceId}-${snapshotId}.cfs`);
    let staging: FileHandle | undefined;
    let complete = false;
    try {
      const begun = await transport.request({ type: 'SnapshotBegin', snapshotId, format: 'cfs-v1' });
      if (!begun.ok || begun.size === undefined || !Number.isSafeInteger(begun.size) || begun.size < 0 || begun.size > 1024 * 1024 * 1024 || !begun.digest || !isDigest(begun.digest)) {
        const code = begun.errorCode === 'SNAPSHOT_LIMIT' || begun.errorCode === 'SNAPSHOT_UNSUPPORTED_ENTRY'
          ? begun.errorCode
          : 'BACKEND_ERROR';
        throw new ServiceError(code, begun.error ?? 'Guest agent snapshot begin failed');
      }
      await mkdir(destination, { recursive: true, mode: 0o700 });
      staging = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o400);
      const hasher = createHash('sha256');
      let offset = 0;
      while (offset < begun.size) {
        const response = await transport.request({ type: 'SnapshotRead', snapshotId, offset, limit: 384 * 1024 });
        if (!response.ok || response.data === undefined || response.size !== begun.size) throw new ServiceError('BACKEND_ERROR', response.error ?? 'Guest agent snapshot read failed');
        const chunk = Buffer.from(response.data, 'base64');
        if (chunk.length === 0 || chunk.length > 384 * 1024 || offset + chunk.length > begun.size) {
          throw new ServiceError('BACKEND_ERROR', 'Guest agent returned an invalid snapshot chunk');
        }
        await staging.write(chunk, 0, chunk.length, offset);
        hasher.update(chunk);
        offset += chunk.length;
        if (response.eof) break;
      }
      if (offset !== begun.size || `sha256:${hasher.digest('hex')}` !== begun.digest) {
        throw new ServiceError('BACKEND_ERROR', 'Guest snapshot size or digest mismatch');
      }
      await staging.sync();
      await staging.close();
      staging = undefined;
      complete = true;
      return { workspacePath: handle.workspacePath, cfsPath: path, treeDigest: begun.digest };
    } finally {
      await staging?.close().catch(() => undefined);
      await transport.request({ type: 'SnapshotEnd', snapshotId }).catch(() => undefined);
      if (!complete) await rm(path, { force: true });
    }
  }

  async destroy(handle: BackendHandle): Promise<void> {
    for (const [executionId, record] of this.executions) {
      if (record.transport !== this.transports.get(handle.opaqueId)) continue;
      if (record.state === 'RUNNING') await record.transport.request({ type: 'Kill', executionId, graceMs: 1_000 }).catch(() => undefined);
      this.executions.delete(executionId);
    }
    this.transports.get(handle.opaqueId)?.close();
    this.transports.delete(handle.opaqueId);
    await this.request(`/containers/${handle.opaqueId}?force=true&v=true`, { method: 'DELETE' }).catch(() => undefined);
  }
}
