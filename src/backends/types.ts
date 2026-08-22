import type { AgentRequest, AgentResponse } from '../agent-protocol.ts';
import type { Backend, Digest, NetworkProfile, ResourceProfile } from '../domain/types.ts';

export interface HostProbe {
  readonly nodeId: 'local';
  readonly available: boolean;
  readonly reason?: string;
}

export interface CreateInstanceInput {
  instanceId: string;
  workspacePath: string;
  resourceProfile: ResourceProfile;
  network: NetworkProfile;
}

export interface BackendHandle {
  backend: Backend;
  instanceId: string;
  opaqueId: string;
  workspacePath: string;
}

export interface ExecInput {
  executionId: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  tty: boolean;
  timeoutMs: number;
}

export interface ExecutionHandle {
  backend: Backend;
  instanceId: string;
  executionId: string;
  opaqueId: string;
  tty: boolean;
}

export interface PollInput {
  yieldTimeMs: number;
}

export interface ExecutionResult {
  state: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'TIMED_OUT' | 'CANCELED' | 'LOST';
  exitCode?: number;
  output: Uint8Array;
  startedAt: number;
  finishedAt?: number;
  originalBytes?: number;
  outputOmittedBytes?: number;
}

export interface SnapshotResult {
  workspacePath: string;
  cfsPath?: string;
  treeDigest?: Digest;
}

export interface FileEntry {
  path: string;
  type: 'file' | 'directory' | 'symlink';
  size?: number;
  modifiedAt?: number;
}

export interface FileMatch {
  path: string;
  line: number;
  text: string;
  contextBefore?: string[];
  contextAfter?: string[];
}

export interface FileReadInput {
  path: string;
  offset?: number;
  limit?: number;
  ranges?: Array<{ start: number; end: number }>;
  cursor?: string;
}

export interface FileReadResult {
  path: string;
  lines?: string[];
  entries?: FileEntry[];
  isDirectory: boolean;
  size?: number;
  digest?: Digest;
  nextOffset?: number;
  truncated: boolean;
  nextCursor?: string;
}

export interface FileReadBytesInput {
  path: string;
  offset: number;
  limit: number;
}

export interface FileReadBytesResult {
  data: Uint8Array;
  size: number;
  eof: boolean;
}

export interface FileWriteInput {
  path: string;
  source: ReadableStream<Uint8Array>;
  createParents: boolean;
}

export interface FileWriteResult {
  path: string;
  size: number;
  digest: Digest;
}

export interface FileEditInput {
  path: string;
  expectedDigest: Digest;
  edits: Array<{
    kind: 'replace' | 'insert_before' | 'insert_after' | 'delete';
    startLine: number;
    endLine?: number;
    content?: string;
  }>;
}

export interface FileEditResult {
  path: string;
  linesBefore: number;
  linesAfter: number;
  digest: Digest;
}

export interface FileGlobInput {
  patterns: string[];
  limit?: number;
  cursor?: string;
  gitignore?: boolean;
  hidden?: boolean;
  sort?: 'name' | 'modified';
}

export interface FileGlobResult {
  entries: FileEntry[];
  truncated: boolean;
  nextCursor?: string;
}

export interface FileGrepInput {
  pattern: string;
  paths?: string[];
  limit?: number;
  cursor?: string;
  caseSensitive?: boolean;
  contextBefore?: number;
  contextAfter?: number;
  gitignore?: boolean;
}

export interface FileGrepResult {
  matches: FileMatch[];
  totalMatches: number;
  skippedFiles: number;
  truncated: boolean;
  nextCursor?: string;
}

export interface FileStatInput {
  path: string;
}

export interface FileStatResult {
  path: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  mode: number;
  modifiedAt: number;
}

export interface FileMoveInput {
  source: string;
  destination: string;
}

export interface FileMoveResult {
  source: string;
  destination: string;
}

export interface FileRemoveInput {
  path: string;
}

export interface AgentTransport {
  request(input: AgentRequest): Promise<AgentResponse>;
  close(): void;
}

export interface InstantBackend {
  readonly kind: Backend;
  preflight(): Promise<HostProbe>;
  create(input: CreateInstanceInput): Promise<BackendHandle>;
  exec(handle: BackendHandle, input: ExecInput): Promise<ExecutionHandle>;
  poll(execution: ExecutionHandle, input: PollInput): Promise<ExecutionResult>;
  write(execution: ExecutionHandle, chars: string): Promise<void>;
  kill(execution: ExecutionHandle): Promise<void>;
  snapshot(handle: BackendHandle, destination: string): Promise<SnapshotResult>;
  fileRead(handle: BackendHandle, request: FileReadInput): Promise<FileReadResult>;
  fileReadBytes(handle: BackendHandle, request: FileReadBytesInput): Promise<FileReadBytesResult>;
  fileWrite(handle: BackendHandle, request: FileWriteInput): Promise<FileWriteResult>;
  fileEdit(handle: BackendHandle, request: FileEditInput): Promise<FileEditResult>;
  fileGlob(handle: BackendHandle, request: FileGlobInput): Promise<FileGlobResult>;
  fileGrep(handle: BackendHandle, request: FileGrepInput): Promise<FileGrepResult>;
  fileStat(handle: BackendHandle, request: FileStatInput): Promise<FileStatResult>;
  fileMove(handle: BackendHandle, request: FileMoveInput): Promise<FileMoveResult>;
  fileRemove(handle: BackendHandle, request: FileRemoveInput): Promise<void>;
  destroy(handle: BackendHandle): Promise<void>;
}

export class BackendRegistry {
  private readonly backends: Record<Backend, InstantBackend>;

  constructor(docker: InstantBackend, firecracker: InstantBackend) {
    this.backends = { docker, firecracker };
  }

  get(kind: Backend): InstantBackend {
    return this.backends[kind];
  }

  async preflight(): Promise<Record<Backend, HostProbe>> {
    const [docker, firecracker] = await Promise.all([
      this.backends.docker.preflight(),
      this.backends.firecracker.preflight(),
    ]);
    return { docker, firecracker };
  }
}
