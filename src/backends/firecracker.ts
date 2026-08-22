import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, access, chmod, chown, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Subprocess } from 'bun';
import type { AgentRequest, AgentResponse } from '../agent-protocol.ts';
import type { Config } from '../daemon/config.ts';
import { ServiceError } from '../domain/errors.ts';
import { isDigest } from '../domain/types.ts';
import { AgentFrameChannel, SocketFrameWriter } from './agent-transport.ts';
import { AgentFileClient } from './agent-files.ts';
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

interface FirecrackerInstance {
  id: string;
  process: Subprocess;
  apiSocket: string;
  jailRoot: string;
  transport: FirecrackerVsockTransport;
}

interface FirecrackerExecution {
  transport: FirecrackerVsockTransport;
  startedAt: number;
  state: ExecutionResult['state'];
  exitCode?: number;
  finishedAt?: number;
  output: Buffer;
  originalBytes: number;
  outputOmittedBytes: number;
}

interface VsockState {
  transport: FirecrackerVsockTransport;
}

class FirecrackerVsockTransport implements AgentTransport {
  private socket?: Bun.Socket<VsockState>;
  private channel?: AgentFrameChannel;
  private readonly writer = new SocketFrameWriter();
  private handshake = Buffer.alloc(0);
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readonly ready = new Promise<void>((resolve, reject) => {
    this.readyResolve = resolve;
    this.readyReject = reject;
  });
  private connected = false;

  private constructor() {}

  private static async connectOnce(path: string): Promise<FirecrackerVsockTransport> {
    const transport = new FirecrackerVsockTransport();
    transport.socket = await Bun.connect<VsockState>({
      unix: path,
      data: { transport },
      socket: {
        open(socket) {
          transport.writer.attach(socket);
          socket.write('CONNECT 5000\n');
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
          transport.fail(new Error('Firecracker vsock connection closed'));
        },
      },
    });
    transport.channel = new AgentFrameChannel(
      (frame) => transport.writer.write(frame),
      () => transport.socket?.end(),
    );
    await transport.ready;
    const probe = await transport.request({ type: 'Poll', executionId: '00000000-0000-0000-0000-000000000000' });
    if (probe.ok || probe.error !== 'execution unavailable') throw new Error(probe.error ?? 'Guest agent readiness probe failed');
    return transport;
  }

  static async connect(path: string, timeoutMs: number): Promise<FirecrackerVsockTransport> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return await FirecrackerVsockTransport.connectOnce(path);
      } catch (error) {
        lastError = error;
        await Bun.sleep(50);
      }
    }
    throw new ServiceError('BACKEND_ERROR', `Firecracker guest agent did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  private onData(chunk: Buffer): void {
    if (!this.connected) {
      this.handshake = Buffer.concat([this.handshake, chunk]);
      const newline = this.handshake.indexOf('\n');
      if (newline < 0) return;
      const line = this.handshake.subarray(0, newline).toString('utf8');
      if (!/^OK \d+$/.test(line)) {
        this.fail(new Error(`Firecracker vsock handshake failed: ${line}`));
        return;
      }
      const remainder = this.handshake.subarray(newline + 1);
      this.handshake = Buffer.alloc(0);
      this.connected = true;
      this.readyResolve();
      if (remainder.length > 0) this.channel?.push(remainder);
      return;
    }
    this.channel?.push(chunk);
  }

  private fail(error: Error): void {
    if (!this.connected) this.readyReject(error);
    this.channel?.fail(error);
    this.writer.clear();
  }

  async request(input: AgentRequest): Promise<AgentResponse> {
    await this.ready;
    if (!this.channel) throw new ServiceError('BACKEND_ERROR', 'Firecracker agent transport is unavailable');
    return this.channel.request(input);
  }

  close(): void {
    this.channel?.close();
    this.writer.clear();
  }
}

function pad4(length: number): number {
  return (4 - (length % 4)) % 4;
}

function cpioEntry(name: string, mode: number, content: Buffer, inode: number, rdevMajor = 0, rdevMinor = 0): Buffer {
  const nameBytes = Buffer.from(`${name}\0`);
  const fields = [inode, mode, 0, 0, 1, 0, content.length, 0, 0, rdevMajor, rdevMinor, nameBytes.length, 0]
    .map((value) => value.toString(16).padStart(8, '0'))
    .join('');
  const header = Buffer.from(`070701${fields}`, 'ascii');
  return Buffer.concat([
    header,
    nameBytes,
    Buffer.alloc(pad4(header.length + nameBytes.length)),
    content,
    Buffer.alloc(pad4(content.length)),
  ]);
}

async function createInitramfs(agentPath: string, destination: string): Promise<void> {
  const agent = Buffer.from(await readFile(agentPath));
  const archive = Buffer.concat([
    cpioEntry('dev', 0o040755, Buffer.alloc(0), 1),
    cpioEntry('dev/console', 0o020600, Buffer.alloc(0), 2, 5, 1),
    cpioEntry('init', 0o100755, agent, 3),
    cpioEntry('TRAILER!!!', 0, Buffer.alloc(0), 4),
  ]);
  await writeFile(destination, archive, { mode: 0o440 });
}

async function runTool(command: string, args: string[]): Promise<string> {
  const process = Bun.spawn([command, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new ServiceError('BACKEND_ERROR', `${basename(command)} failed: ${stderr.trim()}`);
  return `${stdout}${stderr}`.trim();
}

function versionOf(output: string): string | undefined {
  return output.match(/\b(?:v)?(\d+\.\d+\.\d+)\b/)?.[1];
}

function majorMinor(device: number): string {
  const major = (device >> 8) & 0xfff;
  const minor = (device & 0xff) | ((device >> 12) & 0xfff00);
  return `${major}:${minor}`;
}
async function writeCgroupFile(path: string, content: string): Promise<void> {
  const file = await open(path, constants.O_WRONLY);
  try {
    await file.writeFile(content);
  } finally {
    await file.close();
  }
}

export class FirecrackerBackend implements InstantBackend {
  readonly kind = 'firecracker' as const;
  private probe: HostProbe = { nodeId: 'local', available: false, reason: 'preflight not run' };
  private readonly instances = new Map<string, FirecrackerInstance>();
  private readonly executions = new Map<string, FirecrackerExecution>();

  constructor(private readonly config: Config) {}

  async preflight(): Promise<HostProbe> {
    const failures: string[] = [];
    if (process.platform !== 'linux' || process.arch !== 'x64') failures.push('Linux x86_64 is required');
    await access('/dev/kvm', constants.R_OK | constants.W_OK).catch(() => failures.push('/dev/kvm is not readable and writable'));
    const controllers = await Bun.file('/sys/fs/cgroup/cgroup.controllers').text().catch(() => '');
    for (const controller of ['cpu', 'io', 'memory', 'pids']) {
      if (!controllers.split(/\s+/).includes(controller)) failures.push(`cgroup v2 ${controller} controller is unavailable`);
    }
    await access('/sys/fs/cgroup', constants.W_OK).catch(() => failures.push('cgroup v2 root is not writable'));
    for (const [label, path, mode] of [
      ['firecracker', this.config.firecrackerBin, constants.X_OK],
      ['jailer', this.config.jailerBin, constants.X_OK],
      ['agent', this.config.agentArtifact, constants.R_OK],
      ['kernel', this.config.firecrackerKernel, constants.R_OK],
      ['rootfs', this.config.firecrackerRootfs, constants.R_OK],
    ] as const) {
      if (!path) failures.push(`${label} artifact is not configured`);
      else await access(path, mode).catch(() => failures.push(`${label} artifact is inaccessible`));
    }
    if (!Bun.which('mkfs.ext4')) failures.push('mkfs.ext4 is unavailable');
    if (failures.length === 0 && this.config.firecrackerBin && this.config.jailerBin) {
      const [firecrackerVersion, jailerVersion] = await Promise.all([
        runTool(this.config.firecrackerBin, ['--version']).catch((error) => {
          failures.push(error instanceof Error ? error.message : String(error));
          return '';
        }),
        runTool(this.config.jailerBin, ['--version']).catch((error) => {
          failures.push(error instanceof Error ? error.message : String(error));
          return '';
        }),
      ]);
      if (versionOf(firecrackerVersion) !== versionOf(jailerVersion)) failures.push('Firecracker and jailer versions do not match');
    }
    for (const path of [this.config.firecrackerBin, this.config.jailerBin]) {
      if (!path) continue;
      const owner = await stat(path).catch(() => undefined);
      if (owner && owner.uid !== 0 && owner.uid !== process.getuid?.()) failures.push(`${basename(path)} is not owned by root or the daemon user`);
    }
    this.probe = failures.length === 0
      ? { nodeId: 'local', available: true }
      : { nodeId: 'local', available: false, reason: failures.join('; ') };
    return this.probe;
  }

  private ensureAvailable(): void {
    if (!this.probe.available) throw new ServiceError('BACKEND_UNAVAILABLE', this.probe.reason ?? 'Firecracker backend is unavailable');
  }

  private async api(socket: string, path: string, body: unknown): Promise<void> {
    const response = await fetch(`http://localhost${path}`, {
      unix: socket,
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new ServiceError('BACKEND_ERROR', `Firecracker API ${path} failed: ${response.status} ${await response.text()}`);
  }

  private async waitForSocket(path: string, process: Subprocess): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        await access(path, constants.F_OK);
        return;
      } catch {
        // The jailer may still be creating the Unix socket.
      }
      if (process.exitCode !== null) throw new ServiceError('BACKEND_ERROR', `jailer exited with code ${process.exitCode}`);
      await Bun.sleep(25);
    }
    throw new ServiceError('BACKEND_ERROR', 'Firecracker API socket did not become ready');
  }

  private async configureCgroup(id: string, input: CreateInstanceInput, workspaceImage: string): Promise<void> {
    const parent = join('/sys/fs/cgroup', 'electrosphere');
    await mkdir(parent, { recursive: true });
    await writeCgroupFile(join(parent, 'cgroup.subtree_control'), '+cpu +io +memory +pids');
    const path = join(parent, id);
    await mkdir(path, { recursive: true });
    const period = 100_000;
    const device = majorMinor(Number((await stat(workspaceImage)).dev));
    const ioLimit = await Bun.file(join('/sys/dev/block', device)).exists()
      ? writeCgroupFile(join(path, 'io.max'), `${device} rbps=268435456 wbps=268435456`)
      : Promise.resolve();
    await Promise.all([
      writeCgroupFile(join(path, 'memory.max'), String(input.resourceProfile.memoryMiB * 1024 * 1024)),
      writeCgroupFile(join(path, 'memory.swap.max'), '0'),
      writeCgroupFile(join(path, 'cpu.max'), `${input.resourceProfile.vcpus * period} ${period}`),
      writeCgroupFile(join(path, 'pids.max'), String(input.resourceProfile.pidsMax)),
      ioLimit,
    ]);
  }

  async create(input: CreateInstanceInput): Promise<BackendHandle> {
    this.ensureAvailable();
    if (input.network === 'egress') throw new ServiceError('BACKEND_UNAVAILABLE', 'Firecracker egress requires an installed nftables policy');
    const firecrackerBin = this.config.firecrackerBin!;
    const jailerBin = this.config.jailerBin!;
    const kernel = this.config.firecrackerKernel!;
    const rootfs = this.config.firecrackerRootfs!;
    const agent = this.config.agentArtifact!;
    const uid = process.getuid?.() === 0 ? 65534 : process.getuid?.() ?? 65534;
    const gid = process.getgid?.() === 0 ? 65534 : process.getgid?.() ?? 65534;
    const jailBase = join(this.config.dataDir, 'firecracker', 'jailer');
    const jailRoot = join(jailBase, basename(firecrackerBin), input.instanceId, 'root');
    const runDirectory = join(jailRoot, 'run');
    await mkdir(runDirectory, { recursive: true, mode: 0o770 });
    const kernelCopy = join(jailRoot, 'kernel');
    const rootfsCopy = join(jailRoot, 'rootfs.ext4');
    const workspaceImage = join(jailRoot, 'workspace.ext4');
    const initramfs = join(jailRoot, 'initramfs');
    await Promise.all([copyFile(kernel, kernelCopy), copyFile(rootfs, rootfsCopy)]);
    const workspaceFile = await open(workspaceImage, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await workspaceFile.truncate(input.resourceProfile.diskMiB * 1024 * 1024);
    } finally {
      await workspaceFile.close();
    }
    await runTool(Bun.which('mkfs.ext4')!, ['-q', '-F', '-d', input.workspacePath, '-L', 'workspace', workspaceImage]);
    await createInitramfs(agent, initramfs);
    await Promise.all([
      chmod(kernelCopy, 0o440),
      chmod(rootfsCopy, 0o440),
      chmod(initramfs, 0o440),
      chmod(workspaceImage, 0o660),
      chown(runDirectory, uid, gid),
      chown(kernelCopy, uid, gid),
      chown(rootfsCopy, uid, gid),
      chown(initramfs, uid, gid),
      chown(workspaceImage, uid, gid),
    ]);
    await this.configureCgroup(input.instanceId, input, workspaceImage);
    const apiSocket = join(runDirectory, 'firecracker.socket');
    const vsockSocket = join(runDirectory, 'vsock.socket');
    const processHandle = Bun.spawn([
      jailerBin,
      '--id', input.instanceId,
      '--exec-file', firecrackerBin,
      '--uid', String(uid),
      '--gid', String(gid),
      '--cgroup-version', '2',
      '--parent-cgroup', `electrosphere/${input.instanceId}`,
      '--chroot-base-dir', jailBase,
      '--resource-limit', `fsize=${input.resourceProfile.diskMiB * 1024 * 1024}`,
      '--resource-limit', 'no-file=1024',
      '--',
      '--api-sock', '/run/firecracker.socket',
    ], { stdout: 'ignore', stderr: 'ignore' });
    try {
      await this.waitForSocket(apiSocket, processHandle);
      await this.api(apiSocket, '/machine-config', {
        vcpu_count: input.resourceProfile.vcpus,
        mem_size_mib: input.resourceProfile.memoryMiB,
        smt: false,
        track_dirty_pages: false,
      });
      await this.api(apiSocket, '/boot-source', {
        kernel_image_path: '/kernel',
        initrd_path: '/initramfs',
        boot_args: 'console=ttyS0 reboot=k panic=1 pci=off electrosphere.firecracker=1',
      });
      await this.api(apiSocket, '/drives/rootfs', { drive_id: 'rootfs', path_on_host: '/rootfs.ext4', is_root_device: true, is_read_only: true });
      await this.api(apiSocket, '/drives/workspace', { drive_id: 'workspace', path_on_host: '/workspace.ext4', is_root_device: false, is_read_only: false });
      const guestCid = 3 + Number.parseInt(createHash('sha256').update(input.instanceId).digest('hex').slice(0, 6), 16);
      await this.api(apiSocket, '/vsock', { guest_cid: guestCid, uds_path: '/run/vsock.socket' });
      await this.api(apiSocket, '/actions', { action_type: 'InstanceStart' });
      const transport = await FirecrackerVsockTransport.connect(vsockSocket, 15_000);
      this.instances.set(input.instanceId, { id: input.instanceId, process: processHandle, apiSocket, jailRoot, transport });
      return { backend: 'firecracker', instanceId: input.instanceId, opaqueId: input.instanceId, workspacePath: input.workspacePath };
    } catch (error) {
      processHandle.kill('SIGKILL');
      await rm(dirname(jailRoot), { recursive: true, force: true });
      await rm(join('/sys/fs/cgroup', 'electrosphere', input.instanceId), { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private instance(handle: BackendHandle): FirecrackerInstance {
    const instance = this.instances.get(handle.opaqueId);
    if (!instance) throw new ServiceError('BACKEND_ERROR', 'Firecracker instance is unavailable');
    return instance;
  }

  private fileTransport(handle: BackendHandle): AgentFileClient {
    const instance = this.instances.get(handle.opaqueId);
    if (!instance) throw new ServiceError('NOT_FOUND', 'Firecracker turn runtime is unavailable');
    return new AgentFileClient(instance.transport);
  }

  async exec(handle: BackendHandle, input: ExecInput): Promise<ExecutionHandle> {
    const transport = this.instance(handle).transport;
    const response = await transport.request({ type: 'Exec', executionId: input.executionId, command: input.command, cwd: input.cwd, env: input.env, tty: input.tty, timeoutMs: input.timeoutMs });
    if (!response.ok) throw new ServiceError('BACKEND_ERROR', response.error ?? 'Firecracker guest rejected execution');
    this.executions.set(input.executionId, { transport, startedAt: Date.now(), state: 'RUNNING', output: Buffer.alloc(0), originalBytes: 0, outputOmittedBytes: 0 });
    return { backend: 'firecracker', instanceId: handle.instanceId, executionId: input.executionId, opaqueId: input.executionId, tty: input.tty };
  }

  async poll(execution: ExecutionHandle, input: PollInput): Promise<ExecutionResult> {
    const record = this.executions.get(execution.executionId);
    if (!record) throw new ServiceError('NOT_FOUND', 'Execution is unavailable');
    const deadline = Date.now() + input.yieldTimeMs;
    do {
      const response = await record.transport.request({ type: 'Poll', executionId: execution.executionId });
      if (response.errorCode === 'STORAGE_EXHAUSTED') throw new ServiceError('STORAGE_EXHAUSTED', response.error ?? 'Workspace disk is full');
      if (!response.ok) throw new ServiceError('BACKEND_ERROR', response.error ?? 'Firecracker guest poll failed');
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
    if (!response.ok) throw new ServiceError('BACKEND_ERROR', response.error ?? 'Firecracker guest write failed');
  }

  async kill(execution: ExecutionHandle): Promise<void> {
    const record = this.executions.get(execution.executionId);
    if (!record || record.state !== 'RUNNING') return;
    const response = await record.transport.request({ type: 'Kill', executionId: execution.executionId, graceMs: 1_000 });
    if (!response.ok) throw new ServiceError('BACKEND_ERROR', response.error ?? 'Firecracker guest kill failed');
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
    const instance = this.instance(handle);
    const snapshotId = crypto.randomUUID();
    const path = join(destination, `${handle.instanceId}-${snapshotId}.cfs`);
    let staging: FileHandle | undefined;
    let complete = false;
    try {
      const begun = await instance.transport.request({ type: 'SnapshotBegin', snapshotId, format: 'cfs-v1' });
      if (!begun.ok || begun.size === undefined || !Number.isSafeInteger(begun.size) || begun.size < 0 || begun.size > 1024 * 1024 * 1024 || !begun.digest || !isDigest(begun.digest)) {
        const code = begun.errorCode === 'SNAPSHOT_LIMIT' || begun.errorCode === 'SNAPSHOT_UNSUPPORTED_ENTRY'
          ? begun.errorCode
          : 'BACKEND_ERROR';
        throw new ServiceError(code, begun.error ?? 'Firecracker guest snapshot begin failed');
      }
      await mkdir(destination, { recursive: true, mode: 0o700 });
      staging = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o400);
      const hasher = createHash('sha256');
      let offset = 0;
      while (offset < begun.size) {
        const response = await instance.transport.request({ type: 'SnapshotRead', snapshotId, offset, limit: 384 * 1024 });
        if (!response.ok || response.data === undefined || response.size !== begun.size) throw new ServiceError('BACKEND_ERROR', response.error ?? 'Firecracker guest snapshot read failed');
        const chunk = Buffer.from(response.data, 'base64');
        if (chunk.length === 0 || chunk.length > 384 * 1024 || offset + chunk.length > begun.size) {
          throw new ServiceError('BACKEND_ERROR', 'Firecracker guest returned an invalid snapshot chunk');
        }
        await staging.write(chunk, 0, chunk.length, offset);
        hasher.update(chunk);
        offset += chunk.length;
        if (response.eof) break;
      }
      if (offset !== begun.size || `sha256:${hasher.digest('hex')}` !== begun.digest) {
        throw new ServiceError('BACKEND_ERROR', 'Firecracker guest snapshot size or digest mismatch');
      }
      await staging.sync();
      await staging.close();
      staging = undefined;
      complete = true;
      return { workspacePath: handle.workspacePath, cfsPath: path, treeDigest: begun.digest };
    } finally {
      await staging?.close().catch(() => undefined);
      await instance.transport.request({ type: 'SnapshotEnd', snapshotId }).catch(() => undefined);
      if (!complete) await rm(path, { force: true });
    }
  }

  async destroy(handle: BackendHandle): Promise<void> {
    const instance = this.instances.get(handle.opaqueId);
    if (!instance) return;
    for (const [executionId, execution] of this.executions) {
      if (execution.transport !== instance.transport) continue;
      if (execution.state === 'RUNNING') await execution.transport.request({ type: 'Kill', executionId, graceMs: 1_000 }).catch(() => undefined);
      this.executions.delete(executionId);
    }
    instance.transport.close();
    await this.api(instance.apiSocket, '/actions', { action_type: 'SendCtrlAltDel' }).catch(() => undefined);
    await Promise.race([instance.process.exited, Bun.sleep(1000)]);
    if (instance.process.exitCode === null) instance.process.kill('SIGKILL');
    this.instances.delete(handle.opaqueId);
    await rm(dirname(instance.jailRoot), { recursive: true, force: true });
    await rm(join('/sys/fs/cgroup', 'electrosphere', instance.id), { recursive: true, force: true }).catch(() => undefined);
  }
}
