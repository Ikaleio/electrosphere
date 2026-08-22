import type { AgentResponse } from '../agent-protocol.ts';
import { ServiceError } from '../domain/errors.ts';
import { isDigest } from '../domain/types.ts';
import type {
  AgentTransport,
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
} from './types.ts';

const MAX_CHUNK_BYTES = 384 * 1024;
const MAX_ENCODED_RESPONSE_BYTES = 1_500_000;

function agentError(response: AgentResponse, fallback: string): ServiceError {
  const message = response.error ?? fallback;
  switch (response.errorCode) {
    case 'INVALID_ARGUMENT':
    case 'PATH_OUTSIDE_WORKSPACE':
    case 'FILE_TOO_LARGE':
    case 'REGEX_LIMIT':
      return new ServiceError('INVALID_ARGUMENT', message);
    case 'FILE_NOT_FOUND':
    case 'TRANSFER_NOT_FOUND':
      return new ServiceError('NOT_FOUND', message);
    case 'TRANSFER_CAPACITY':
    case 'STORAGE_EXHAUSTED':
      return new ServiceError('STORAGE_EXHAUSTED', message);
    case 'INVALID_EDIT':
      return new ServiceError('HEAD_CONFLICT', message, {
        ...(response.details?.currentDigest ? { currentDigest: response.details.currentDigest } : {}),
      });
    case 'BACKEND_UNAVAILABLE':
      return new ServiceError('BACKEND_UNAVAILABLE', message);
    case 'SNAPSHOT_LIMIT':
      return new ServiceError('SNAPSHOT_LIMIT', message);
    case 'SNAPSHOT_UNSUPPORTED_ENTRY':
      return new ServiceError('SNAPSHOT_UNSUPPORTED_ENTRY', message);
    default:
      return new ServiceError('BACKEND_ERROR', message);
  }
}

function requireOk(response: AgentResponse, fallback: string): void {
  if (!response.ok) throw agentError(response, fallback);
}

function guardEncodedResponse(response: AgentResponse, operation: string): void {
  if (Buffer.byteLength(JSON.stringify(response), 'utf8') > MAX_ENCODED_RESPONSE_BYTES) {
    throw new ServiceError('BACKEND_ERROR', `Guest agent ${operation} response exceeds transport-safe limit`);
  }
}

function requireDigest(value: string | undefined, operation: string) {
  if (!value || !isDigest(value)) throw new ServiceError('BACKEND_ERROR', `Guest agent ${operation} returned an invalid digest`);
  return value;
}

function requireNumber(value: number | undefined, operation: string): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw new ServiceError('BACKEND_ERROR', `Guest agent ${operation} returned an invalid number`);
  }
  return value;
}

export class AgentFileClient {
  constructor(private readonly transport: AgentTransport) {}

  async read(request: FileReadInput): Promise<FileReadResult> {
    const response = await this.transport.request({
      type: 'FileRead',
      path: request.path,
      ...(request.offset !== undefined ? { offset: request.offset } : {}),
      ...(request.limit !== undefined ? { limit: request.limit } : {}),
      ...(request.ranges ? { ranges: request.ranges } : {}),
      ...(request.cursor ? { cursor: request.cursor } : {}),
    });
    requireOk(response, 'Guest agent file read failed');
    guardEncodedResponse(response, 'file read');
    const isDirectory = response.isDirectory ?? false;
    if (isDirectory && !response.entries) throw new ServiceError('BACKEND_ERROR', 'Guest agent directory read omitted entries');
    if (!isDirectory && (!response.lines || response.size === undefined || !response.digest)) {
      throw new ServiceError('BACKEND_ERROR', 'Guest agent file read omitted required fields');
    }
    return {
      path: request.path,
      ...(response.lines ? { lines: response.lines } : {}),
      ...(response.entries ? { entries: response.entries } : {}),
      isDirectory,
      ...(response.size !== undefined ? { size: requireNumber(response.size, 'file read') } : {}),
      ...(response.digest ? { digest: requireDigest(response.digest, 'file read') } : {}),
      ...(response.nextOffset !== undefined ? { nextOffset: requireNumber(response.nextOffset, 'file read') } : {}),
      truncated: response.truncated ?? false,
      ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
    };
  }

  async readBytes(request: FileReadBytesInput): Promise<FileReadBytesResult> {
    const response = await this.transport.request({
      type: 'FileReadBytes',
      path: request.path,
      offset: request.offset,
      limit: request.limit,
    });
    requireOk(response, 'Guest agent byte read failed');
    if (response.data === undefined || response.size === undefined || response.eof === undefined) {
      throw new ServiceError('BACKEND_ERROR', 'Guest agent byte read omitted required fields');
    }
    const data = Buffer.from(response.data, 'base64');
    if (data.byteLength > request.limit || data.byteLength > MAX_CHUNK_BYTES) {
      throw new ServiceError('BACKEND_ERROR', 'Guest agent byte read exceeded requested limit');
    }
    const size = requireNumber(response.size, 'byte read');
    if (request.offset + data.byteLength > size) throw new ServiceError('BACKEND_ERROR', 'Guest agent byte read exceeds reported file size');
    return { data, size, eof: response.eof };
  }

  async write(request: FileWriteInput): Promise<FileWriteResult> {
    const transferId = crypto.randomUUID();
    const reader = request.source.getReader();
    let committed = false;
    try {
      const begun = await this.transport.request({
        type: 'FileWriteBegin',
        transferId,
        path: request.path,
        createParents: request.createParents,
      });
      requireOk(begun, 'Guest agent file write begin failed');
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        for (let offset = 0; offset < next.value.byteLength; offset += MAX_CHUNK_BYTES) {
          const chunk = next.value.subarray(offset, Math.min(next.value.byteLength, offset + MAX_CHUNK_BYTES));
          if (chunk.byteLength === 0) continue;
          const written = await this.transport.request({
            type: 'FileWriteChunk',
            transferId,
            data: Buffer.from(chunk).toString('base64'),
          });
          requireOk(written, 'Guest agent file write chunk failed');
        }
      }
      const completed = await this.transport.request({ type: 'FileWriteCommit', transferId });
      requireOk(completed, 'Guest agent file write commit failed');
      const size = requireNumber(completed.size, 'file write');
      const digest = requireDigest(completed.digest, 'file write');
      committed = true;
      return { path: request.path, size, digest };
    } finally {
      reader.releaseLock();
      if (!committed) await this.transport.request({ type: 'FileWriteAbort', transferId }).catch(() => undefined);
    }
  }

  async edit(request: FileEditInput): Promise<FileEditResult> {
    const response = await this.transport.request({
      type: 'FileEdit',
      path: request.path,
      expectedDigest: request.expectedDigest,
      edits: request.edits,
    });
    requireOk(response, 'Guest agent file edit failed');
    return {
      path: request.path,
      linesBefore: requireNumber(response.linesBefore, 'file edit'),
      linesAfter: requireNumber(response.linesAfter, 'file edit'),
      digest: requireDigest(response.digest, 'file edit'),
    };
  }

  async glob(request: FileGlobInput): Promise<FileGlobResult> {
    const response = await this.transport.request({
      type: 'FileGlob',
      patterns: request.patterns,
      ...(request.limit !== undefined ? { limit: request.limit } : {}),
      ...(request.cursor ? { cursor: request.cursor } : {}),
      ...(request.gitignore !== undefined ? { gitignore: request.gitignore } : {}),
      ...(request.hidden !== undefined ? { hidden: request.hidden } : {}),
      ...(request.sort ? { sort: request.sort } : {}),
    });
    requireOk(response, 'Guest agent glob failed');
    guardEncodedResponse(response, 'glob');
    if (!response.entries) throw new ServiceError('BACKEND_ERROR', 'Guest agent glob omitted entries');
    return {
      entries: response.entries,
      truncated: response.truncated ?? false,
      ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
    };
  }

  async grep(request: FileGrepInput): Promise<FileGrepResult> {
    const response = await this.transport.request({
      type: 'FileGrep',
      pattern: request.pattern,
      ...(request.paths ? { paths: request.paths } : {}),
      ...(request.limit !== undefined ? { limit: request.limit } : {}),
      ...(request.cursor ? { cursor: request.cursor } : {}),
      ...(request.caseSensitive !== undefined ? { caseSensitive: request.caseSensitive } : {}),
      ...(request.contextBefore !== undefined ? { contextBefore: request.contextBefore } : {}),
      ...(request.contextAfter !== undefined ? { contextAfter: request.contextAfter } : {}),
      ...(request.gitignore !== undefined ? { gitignore: request.gitignore } : {}),
    });
    requireOk(response, 'Guest agent grep failed');
    guardEncodedResponse(response, 'grep');
    if (!response.matches) throw new ServiceError('BACKEND_ERROR', 'Guest agent grep omitted matches');
    return {
      matches: response.matches,
      totalMatches: requireNumber(response.totalMatches, 'grep'),
      skippedFiles: requireNumber(response.skippedFiles, 'grep'),
      truncated: response.truncated ?? false,
      ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
    };
  }

  async stat(request: FileStatInput): Promise<FileStatResult> {
    const response = await this.transport.request({ type: 'FileStat', path: request.path });
    requireOk(response, 'Guest agent file stat failed');
    const result = response.statResult;
    if (!result) throw new ServiceError('BACKEND_ERROR', 'Guest agent file stat omitted result');
    return {
      path: request.path,
      type: result.type,
      size: requireNumber(result.size, 'file stat'),
      mode: requireNumber(result.mode, 'file stat'),
      modifiedAt: requireNumber(result.modifiedAt, 'file stat'),
    };
  }

  async move(request: FileMoveInput): Promise<FileMoveResult> {
    const response = await this.transport.request({
      type: 'FileMove',
      source: request.source,
      destination: request.destination,
    });
    requireOk(response, 'Guest agent file move failed');
    return { source: request.source, destination: request.destination };
  }

  async remove(request: FileRemoveInput): Promise<void> {
    const response = await this.transport.request({ type: 'FileRemove', path: request.path });
    requireOk(response, 'Guest agent file remove failed');
  }
}
