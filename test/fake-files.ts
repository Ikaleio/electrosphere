import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { ServiceError } from '../src/domain/errors.ts';
import type { Digest } from '../src/domain/types.ts';
import type {
  BackendHandle,
  FileEditInput,
  FileEditResult,
  FileEntry,
  FileGlobInput,
  FileGlobResult,
  FileGrepInput,
  FileGrepResult,
  FileMatch,
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
} from '../src/backends/types.ts';

const MAX_CHUNK_BYTES = 384 * 1024;
const MAX_WRITE_BYTES = 256 * 1024 * 1024;
const MAX_EDIT_BYTES = 16 * 1024 * 1024;
const MAX_EDIT_CONTENT_BYTES = 768 * 1024;
const MAX_READ_RESPONSE_BYTES = 512 * 1024;
const MAX_SEARCH_RESPONSE_BYTES = 1_500_000;
const MAX_CROSS_LINE_BYTES = 16 * 1024 * 1024;

function digest(bytes: Uint8Array): Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}` as Digest;
}

function validatePath(path: string, allowRoot: boolean): string[] {
  if (path.length === 0) {
    if (allowRoot) return [];
    throw new ServiceError('INVALID_ARGUMENT', 'Workspace root is not valid for this operation');
  }
  if (path.includes('\0') || path.startsWith('/')) throw new ServiceError('INVALID_ARGUMENT', 'Path must be workspace-relative');
  const parts = path.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new ServiceError('INVALID_ARGUMENT', 'Path contains an unsafe component');
  }
  return parts;
}

function validatePattern(pattern: string): void {
  if (pattern.length === 0 || pattern.includes('\0') || pattern.startsWith('/')) {
    throw new ServiceError('INVALID_ARGUMENT', 'Pattern must be workspace-relative');
  }
  if (pattern.split('/').some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new ServiceError('INVALID_ARGUMENT', 'Pattern contains an unsafe component');
  }
}

async function workspaceRoot(handle: BackendHandle): Promise<string> {
  return realpath(handle.workspacePath);
}

function assertInside(root: string, path: string): void {
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new ServiceError('INVALID_ARGUMENT', 'Path escapes workspace');
}

async function existingPath(handle: BackendHandle, path: string, allowRoot: boolean): Promise<string> {
  const parts = validatePath(path, allowRoot);
  const root = await workspaceRoot(handle);
  const candidate = resolve(root, ...parts);
  assertInside(root, candidate);
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ServiceError('NOT_FOUND', 'File not found');
    throw error;
  }
  assertInside(root, resolved);
  return resolved;
}

async function entryPath(handle: BackendHandle, path: string, allowRoot: boolean): Promise<string> {
  const parts = validatePath(path, allowRoot);
  const root = await workspaceRoot(handle);
  const candidate = resolve(root, ...parts);
  assertInside(root, candidate);
  if (parts.length === 0) return root;
  const parent = await realpath(dirname(candidate)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new ServiceError('NOT_FOUND', 'Parent directory not found');
    throw error;
  });
  assertInside(root, parent);
  const target = join(parent, basename(candidate));
  await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new ServiceError('NOT_FOUND', 'File not found');
    throw error;
  });
  return target;
}

async function writableTarget(handle: BackendHandle, path: string, createParents: boolean): Promise<string> {
  const parts = validatePath(path, false);
  const root = await workspaceRoot(handle);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    const next = join(current, part);
    const metadata = await lstat(next).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!metadata) {
      if (!createParents) throw new ServiceError('NOT_FOUND', 'Parent directory not found');
      await mkdir(next, { mode: 0o755 });
    } else if (metadata.isSymbolicLink()) {
      throw new ServiceError('INVALID_ARGUMENT', 'Write parent cannot be a symlink');
    } else if (!metadata.isDirectory()) {
      throw new ServiceError('INVALID_ARGUMENT', 'Write parent is not a directory');
    }
    current = next;
  }
  const target = join(current, parts.at(-1)!);
  assertInside(root, target);
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing?.isSymbolicLink()) throw new ServiceError('INVALID_ARGUMENT', 'Destination cannot be a symlink');
  return target;
}

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor<T>(value: string): T {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
  } catch {
    throw new ServiceError('INVALID_ARGUMENT', 'Cursor is invalid');
  }
}

function textLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function strippedLines(text: string): string[] {
  return textLines(text).map((line) => line.replace(/\r?\n$/, ''));
}

function assertUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ServiceError('INVALID_ARGUMENT', `File is not valid UTF-8: ${path}`);
  }
}

async function gitignoreMatchers(root: string, enabled: boolean): Promise<Bun.Glob[]> {
  if (!enabled) return [];
  const contents = await Bun.file(join(root, '.gitignore')).text().catch(() => '');
  const patterns = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('!'));
  return patterns.flatMap((pattern) => {
    const clean = pattern.replace(/^\//, '').replace(/\/$/, '/**');
    return clean.includes('/') ? [new Bun.Glob(clean)] : [new Bun.Glob(clean), new Bun.Glob(`**/${clean}`)];
  });
}

function ignored(path: string, matchers: Bun.Glob[]): boolean {
  return matchers.some((matcher) => matcher.match(path));
}

async function scanPatterns(root: string, patterns: string[], hidden: boolean): Promise<string[]> {
  const paths = new Set<string>();
  for (const pattern of patterns) {
    validatePattern(pattern);
    const glob = new Bun.Glob(pattern);
    for await (const path of glob.scan({ cwd: root, dot: hidden, absolute: false, followSymlinks: false, onlyFiles: false })) {
      paths.add(path.replaceAll('\\', '/'));
    }
  }
  return [...paths];
}

function compareModified(left: FileEntry, right: FileEntry): number {
  return (right.modifiedAt ?? 0) - (left.modifiedAt ?? 0) || Buffer.compare(Buffer.from(left.path), Buffer.from(right.path));
}

export class FakeFileClient {
  constructor(private readonly handle: BackendHandle) {}

  async read(request: FileReadInput): Promise<FileReadResult> {
    const path = await existingPath(this.handle, request.path, true);
    const metadata = await lstat(path);
    if (metadata.isDirectory()) {
      if (request.offset !== undefined || request.ranges) throw new ServiceError('INVALID_ARGUMENT', 'Directory reads do not accept line offsets or ranges');
      const limit = request.limit ?? 1_000;
      const cursor = request.cursor ? decodeCursor<{ path: string }>(request.cursor) : undefined;
      const names = await readdir(path, { withFileTypes: true });
      const entries = await Promise.all(names.map(async (name): Promise<FileEntry> => {
        const target = join(path, name.name);
        const stat = await lstat(target);
        const relativePath = request.path.length === 0 ? name.name : `${request.path}/${name.name}`;
        const type = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file';
        return {
          path: type === 'directory' ? `${relativePath}/` : relativePath,
          type,
          ...(type === 'file' ? { size: stat.size } : {}),
          modifiedAt: stat.mtimeMs,
        };
      }));
      entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
      const remaining = entries.filter((entry) => !cursor || Buffer.compare(Buffer.from(entry.path), Buffer.from(cursor.path)) > 0);
      const returned: FileEntry[] = [];
      for (const entry of remaining) {
        if (returned.length >= limit) break;
        const candidate = { entries: [...returned, entry], isDirectory: true, truncated: false };
        if (Buffer.byteLength(JSON.stringify(candidate)) > MAX_READ_RESPONSE_BYTES) break;
        returned.push(entry);
      }
      const truncated = returned.length < remaining.length;
      return {
        path: request.path,
        entries: returned,
        isDirectory: true,
        truncated,
        ...(truncated && returned.at(-1) ? { nextCursor: encodeCursor({ path: returned.at(-1)!.path }) } : {}),
      };
    }
    if (!metadata.isFile()) throw new ServiceError('INVALID_ARGUMENT', 'Read requires a regular file or directory');
    if (request.ranges && (request.offset !== undefined || request.limit !== undefined)) {
      throw new ServiceError('INVALID_ARGUMENT', 'ranges cannot be combined with offset or limit');
    }
    const bytes = await readFile(path);
    const lines = textLines(assertUtf8(bytes, request.path));
    const cursor = request.cursor ? decodeCursor<{ nextLine: number }>(request.cursor) : undefined;
    const ranges = request.ranges ? [...request.ranges].sort((left, right) => left.start - right.start) : undefined;
    const firstLine = cursor?.nextLine ?? ranges?.at(0)?.start ?? request.offset ?? 1;
    const maximum = ranges ? Number.POSITIVE_INFINITY : request.limit ?? 200;
    const selected: string[] = [];
    let nextLine: number | undefined;
    for (let index = firstLine - 1; index < lines.length; index += 1) {
      const lineNumber = index + 1;
      if (ranges && !ranges.some((range) => lineNumber >= range.start && lineNumber <= range.end)) continue;
      if (selected.length >= maximum || Buffer.byteLength(JSON.stringify({ lines: [...selected, lines[index]], size: bytes.byteLength, truncated: false })) > MAX_READ_RESPONSE_BYTES) {
        nextLine ??= lineNumber;
        continue;
      }
      selected.push(lines[index]!);
    }
    return {
      path: request.path,
      lines: selected,
      isDirectory: false,
      size: bytes.byteLength,
      digest: digest(bytes),
      ...(ranges ? {} : nextLine !== undefined ? { nextOffset: nextLine } : {}),
      truncated: nextLine !== undefined,
      ...(ranges && nextLine !== undefined ? { nextCursor: encodeCursor({ nextLine }) } : {}),
    };
  }

  async readBytes(request: FileReadBytesInput): Promise<FileReadBytesResult> {
    if (request.limit < 1 || request.limit > MAX_CHUNK_BYTES) throw new ServiceError('INVALID_ARGUMENT', 'Byte read limit is invalid');
    const path = await existingPath(this.handle, request.path, false);
    const metadata = await lstat(path);
    if (!metadata.isFile()) throw new ServiceError('INVALID_ARGUMENT', 'Byte read requires a regular file');
    if (request.offset > metadata.size) throw new ServiceError('INVALID_ARGUMENT', 'Byte offset exceeds file size');
    const file = await open(path, constants.O_RDONLY);
    try {
      const data = Buffer.alloc(Math.min(request.limit, metadata.size - request.offset));
      const { bytesRead } = await file.read(data, 0, data.byteLength, request.offset);
      return { data: data.subarray(0, bytesRead), size: metadata.size, eof: request.offset + bytesRead >= metadata.size };
    } finally {
      await file.close();
    }
  }

  async write(request: FileWriteInput): Promise<FileWriteResult> {
    const target = await writableTarget(this.handle, request.path, request.createParents);
    const temporary = join(dirname(target), `.electrosphere-${crypto.randomUUID()}.tmp`);
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    const hasher = createHash('sha256');
    const reader = request.source.getReader();
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        for (let offset = 0; offset < next.value.byteLength; offset += MAX_CHUNK_BYTES) {
          const chunk = next.value.subarray(offset, Math.min(next.value.byteLength, offset + MAX_CHUNK_BYTES));
          size += chunk.byteLength;
          if (size > MAX_WRITE_BYTES) throw new ServiceError('STORAGE_EXHAUSTED', 'File write exceeds size limit');
          await file.write(chunk);
          hasher.update(chunk);
        }
      }
      await file.sync();
      await file.close();
      await rename(temporary, target);
      return { path: request.path, size, digest: `sha256:${hasher.digest('hex')}` as Digest };
    } catch (error) {
      await file.close().catch(() => undefined);
      await rm(temporary, { force: true });
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  async edit(request: FileEditInput): Promise<FileEditResult> {
    const path = await existingPath(this.handle, request.path, false);
    const metadata = await lstat(path);
    if (!metadata.isFile()) throw new ServiceError('INVALID_ARGUMENT', 'Edit requires a regular file');
    if (metadata.size > MAX_EDIT_BYTES) throw new ServiceError('INVALID_ARGUMENT', 'File exceeds edit size limit');
    const bytes = await readFile(path);
    const currentDigest = digest(bytes);
    if (currentDigest !== request.expectedDigest) throw new ServiceError('HEAD_CONFLICT', 'File digest changed', { currentDigest });
    const lines = textLines(assertUtf8(bytes, request.path));
    const contentBytes = request.edits.reduce((total, edit) => total + Buffer.byteLength(edit.content ?? ''), 0);
    if (contentBytes > MAX_EDIT_CONTENT_BYTES) throw new ServiceError('INVALID_ARGUMENT', 'Edit content exceeds size limit');
    const sorted = [...request.edits].sort((left, right) => left.startLine - right.startLine);
    let priorEnd = 0;
    for (const edit of sorted) {
      const end = edit.endLine ?? edit.startLine;
      if (edit.startLine < 1 || edit.startLine > lines.length || end < edit.startLine || end > lines.length || edit.startLine <= priorEnd) {
        throw new ServiceError('INVALID_ARGUMENT', 'Edit ranges overlap or are invalid');
      }
      if ((edit.kind === 'replace' || edit.kind === 'delete') && edit.endLine === undefined) throw new ServiceError('INVALID_ARGUMENT', `${edit.kind} requires endLine`);
      if ((edit.kind === 'insert_before' || edit.kind === 'insert_after' || edit.kind === 'replace') && edit.content === undefined) throw new ServiceError('INVALID_ARGUMENT', `${edit.kind} requires content`);
      priorEnd = end;
    }
    for (const edit of [...sorted].reverse()) {
      const index = edit.startLine - 1;
      if (edit.kind === 'replace') lines.splice(index, edit.endLine! - edit.startLine + 1, edit.content!);
      else if (edit.kind === 'delete') lines.splice(index, edit.endLine! - edit.startLine + 1);
      else if (edit.kind === 'insert_before') lines.splice(index, 0, edit.content!);
      else lines.splice(index + 1, 0, edit.content!);
    }
    const updated = Buffer.from(lines.join(''), 'utf8');
    if (updated.byteLength > MAX_EDIT_BYTES) throw new ServiceError('INVALID_ARGUMENT', 'Edited file exceeds size limit');
    const target = await writableTarget(this.handle, request.path, false);
    const temporary = join(dirname(target), `.electrosphere-edit-${crypto.randomUUID()}.tmp`);
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, metadata.mode & 0o777);
    try {
      await file.write(updated);
      await file.sync();
      await file.close();
      await chmod(temporary, metadata.mode & 0o777);
      await rename(temporary, target);
    } catch (error) {
      await file.close().catch(() => undefined);
      await rm(temporary, { force: true });
      throw error;
    }
    return { path: request.path, linesBefore: textLines(assertUtf8(bytes, request.path)).length, linesAfter: lines.length, digest: digest(updated) };
  }

  async glob(request: FileGlobInput): Promise<FileGlobResult> {
    if (request.patterns.length === 0) throw new ServiceError('INVALID_ARGUMENT', 'Glob requires patterns');
    const root = await workspaceRoot(this.handle);
    const matchers = await gitignoreMatchers(root, request.gitignore ?? true);
    const paths = await scanPatterns(root, request.patterns, request.hidden ?? false);
    const entries: FileEntry[] = [];
    for (const path of paths) {
      if (ignored(path, matchers)) continue;
      const metadata = await lstat(join(root, path)).catch(() => undefined);
      if (!metadata) continue;
      const type = metadata.isSymbolicLink() ? 'symlink' : metadata.isDirectory() ? 'directory' : 'file';
      entries.push({
        path: type === 'directory' ? `${path}/` : path,
        type,
        ...(type === 'file' ? { size: metadata.size } : {}),
        modifiedAt: metadata.mtimeMs,
      });
    }
    if ((request.sort ?? 'name') === 'modified') entries.sort(compareModified);
    else entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
    const cursor = request.cursor ? decodeCursor<{ path: string; modifiedAt?: number; sort: string }>(request.cursor) : undefined;
    if (cursor && cursor.sort !== (request.sort ?? 'name')) throw new ServiceError('INVALID_ARGUMENT', 'Glob cursor sort does not match request');
    const remaining = entries.filter((entry) => {
      if (!cursor) return true;
      if ((request.sort ?? 'name') === 'name') return Buffer.compare(Buffer.from(entry.path), Buffer.from(cursor.path)) > 0;
      return compareModified(entry, {
        path: cursor.path,
        type: 'file',
        ...(cursor.modifiedAt !== undefined ? { modifiedAt: cursor.modifiedAt } : {}),
      }) > 0;
    });
    const returned: FileEntry[] = [];
    for (const entry of remaining) {
      if (returned.length >= (request.limit ?? 1_000)) break;
      if (Buffer.byteLength(JSON.stringify({ entries: [...returned, entry], truncated: false })) > MAX_SEARCH_RESPONSE_BYTES) break;
      returned.push(entry);
    }
    const truncated = returned.length < remaining.length;
    return {
      entries: returned,
      truncated,
      ...(truncated && returned.at(-1) ? {
        nextCursor: encodeCursor({ path: returned.at(-1)!.path, modifiedAt: returned.at(-1)!.modifiedAt, sort: request.sort ?? 'name' }),
      } : {}),
    };
  }

  async grep(request: FileGrepInput): Promise<FileGrepResult> {
    let regex: RegExp;
    const crossLine = request.pattern.includes('\n') || request.pattern.includes('\\n');
    try {
      regex = new RegExp(request.pattern, `${request.caseSensitive === false ? 'i' : ''}${crossLine ? 's' : ''}`);
    } catch (error) {
      throw new ServiceError('INVALID_ARGUMENT', error instanceof Error ? error.message : String(error));
    }
    const root = await workspaceRoot(this.handle);
    const patterns = request.paths?.length ? request.paths : ['**/*'];
    const expanded: string[] = [];
    for (const pattern of patterns) {
      if (pattern.length === 0) {
        expanded.push('**/*');
        continue;
      }
      validatePattern(pattern);
      if (/[*?[{]/.test(pattern)) expanded.push(pattern);
      else {
        const target = await existingPath(this.handle, pattern, true);
        const metadata = await lstat(target);
        expanded.push(metadata.isDirectory() ? `${pattern}/**/*` : pattern);
      }
    }
    const gitignore = await gitignoreMatchers(root, request.gitignore ?? true);
    const files = (await scanPatterns(root, expanded, true)).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    const cursor = request.cursor ? decodeCursor<{ path: string; line: number }>(request.cursor) : undefined;
    const matches: FileMatch[] = [];
    let totalMatches = 0;
    let skippedFiles = 0;
    let truncated = false;
    let last: { path: string; line: number } | undefined;
    for (const path of files) {
      if (ignored(path, gitignore)) continue;
      const absolute = join(root, path);
      const metadata = await lstat(absolute).catch(() => undefined);
      if (!metadata?.isFile()) continue;
      if (crossLine && metadata.size > MAX_CROSS_LINE_BYTES) {
        skippedFiles += 1;
        continue;
      }
      const bytes = await readFile(absolute);
      const text = assertUtf8(bytes, path);
      if (/(?:\([^)]*[+*][^)]*\))[+*{]/.test(request.pattern) && text.length > 1_000) {
        throw new ServiceError('INVALID_ARGUMENT', 'Regular expression resource limit exceeded');
      }
      const lines = strippedLines(text);
      const indexes = new Set<number>();
      if (crossLine) {
        const global = new RegExp(regex.source, `${regex.flags}g`);
        for (const match of text.matchAll(global)) indexes.add(text.slice(0, match.index).split('\n').length - 1);
      } else {
        lines.forEach((line, index) => {
          regex.lastIndex = 0;
          if (regex.test(line)) indexes.add(index);
        });
      }
      for (const index of [...indexes].sort((left, right) => left - right)) {
        totalMatches += 1;
        const line = index + 1;
        if (cursor && (Buffer.compare(Buffer.from(path), Buffer.from(cursor.path)) < 0 || (path === cursor.path && line <= cursor.line))) continue;
        const value: FileMatch = {
          path,
          line,
          text: lines[index] ?? '',
          ...(request.contextBefore ? { contextBefore: lines.slice(Math.max(0, index - request.contextBefore), index) } : {}),
          ...(request.contextAfter ? { contextAfter: lines.slice(index + 1, index + 1 + request.contextAfter) } : {}),
        };
        if (matches.length >= (request.limit ?? 1_000) || Buffer.byteLength(JSON.stringify({ matches: [...matches, value], totalMatches, skippedFiles, truncated: false })) > MAX_SEARCH_RESPONSE_BYTES) {
          truncated = true;
          continue;
        }
        matches.push(value);
        last = { path, line };
      }
    }
    return { matches, totalMatches, skippedFiles, truncated, ...(truncated && last ? { nextCursor: encodeCursor(last) } : {}) };
  }

  async stat(request: FileStatInput): Promise<FileStatResult> {
    const path = await entryPath(this.handle, request.path, true);
    const metadata = await lstat(path);
    const type = metadata.isSymbolicLink() ? 'symlink' : metadata.isDirectory() ? 'directory' : metadata.isFile() ? 'file' : undefined;
    if (!type) throw new ServiceError('INVALID_ARGUMENT', 'Unsupported workspace entry type');
    return { path: request.path, type, size: metadata.size, mode: metadata.mode & 0o7777, modifiedAt: metadata.mtimeMs };
  }

  async move(request: FileMoveInput): Promise<FileMoveResult> {
    const source = await entryPath(this.handle, request.source, false);
    const destination = await writableTarget(this.handle, request.destination, false);
    await rename(source, destination);
    return { source: request.source, destination: request.destination };
  }

  async remove(request: FileRemoveInput): Promise<void> {
    const path = await entryPath(this.handle, request.path, false);
    await rm(path, { recursive: true, force: false });
  }
}
