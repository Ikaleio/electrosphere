import { createHash } from 'node:crypto';

export type AgentRequest =
  | { type: 'Exec'; executionId: string; command: string; cwd: string; env: Record<string, string>; tty: boolean; timeoutMs: number }
  | { type: 'Write'; executionId: string; chars: string }
  | { type: 'Poll'; executionId: string }
  | { type: 'Kill'; executionId: string; graceMs?: number }
  | { type: 'FileRead'; path: string; offset?: number; limit?: number; ranges?: Array<{ start: number; end: number }>; cursor?: string }
  | { type: 'FileReadBytes'; path: string; offset: number; limit: number }
  | { type: 'FileWriteBegin'; transferId: string; path: string; createParents: boolean }
  | { type: 'FileWriteChunk'; transferId: string; data: string }
  | { type: 'FileWriteCommit'; transferId: string }
  | { type: 'FileWriteAbort'; transferId: string }
  | { type: 'FileEdit'; path: string; expectedDigest: string; edits: Array<{ kind: 'replace' | 'insert_before' | 'insert_after' | 'delete'; startLine: number; endLine?: number; content?: string }> }
  | { type: 'FileGlob'; patterns: string[]; limit?: number; cursor?: string; gitignore?: boolean; hidden?: boolean; sort?: 'name' | 'modified' }
  | { type: 'FileGrep'; pattern: string; paths?: string[]; limit?: number; cursor?: string; caseSensitive?: boolean; contextBefore?: number; contextAfter?: number; gitignore?: boolean }
  | { type: 'FileStat'; path: string }
  | { type: 'FileMove'; source: string; destination: string }
  | { type: 'FileRemove'; path: string }
  | { type: 'SnapshotBegin'; snapshotId: string; format: 'cfs-v1' }
  | { type: 'SnapshotRead'; snapshotId: string; offset: number; limit: number }
  | { type: 'SnapshotEnd'; snapshotId: string };

export type AgentErrorCode =
  | 'INVALID_ARGUMENT'
  | 'SNAPSHOT_LIMIT'
  | 'SNAPSHOT_UNSUPPORTED_ENTRY'
  | 'STORAGE_EXHAUSTED'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'FILE_NOT_FOUND'
  | 'FILE_TOO_LARGE'
  | 'INVALID_EDIT'
  | 'TRANSFER_NOT_FOUND'
  | 'TRANSFER_CAPACITY'
  | 'REGEX_LIMIT'
  | 'BACKEND_UNAVAILABLE';

export interface AgentResponse {
  ok: boolean;
  executionId?: string;
  state?: string;
  exitCode?: number;
  output?: string;
  originalBytes?: number;
  outputOmittedBytes?: number;
  error?: string;
  errorCode?: AgentErrorCode;
  lines?: string[];
  entries?: Array<{ path: string; type: 'file' | 'directory' | 'symlink'; size?: number; modifiedAt?: number }>;
  matches?: Array<{ path: string; line: number; text: string; contextBefore?: string[]; contextAfter?: string[] }>;
  statResult?: { type: 'file' | 'directory' | 'symlink'; size: number; mode: number; modifiedAt: number };
  totalMatches?: number;
  nextOffset?: number;
  skippedFiles?: number;
  isDirectory?: boolean;
  data?: string;
  size?: number;
  digest?: string;
  eof?: boolean;
  details?: { currentDigest?: string };
  truncated?: boolean;
  nextCursor?: string;
  linesBefore?: number;
  linesAfter?: number;
}

export function encodeAgentFrame(message: AgentRequest): Uint8Array {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export function decodeAgentFrame(frame: Uint8Array): AgentResponse {
  const bytes = Buffer.from(frame);
  if (bytes.length < 4) throw new Error('Agent frame is truncated');
  const length = bytes.readUInt32BE(0);
  if (length !== bytes.length - 4) throw new Error('Agent frame length mismatch');
  return JSON.parse(bytes.subarray(4).toString('utf8')) as AgentResponse;
}

export function protocolDigest(): string {
  return createHash('sha256').update('electrosphere-agent-protocol\0v2\0cfs-v1').digest('hex');
}
