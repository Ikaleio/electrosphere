import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import { ServiceError } from '../domain/errors.ts';
import type { SandboxService } from '../domain/sandbox-service.ts';
import type { SessionManager } from '../domain/session-manager.ts';
import type { BoundTurn } from '../domain/turn-service.ts';
import { DIGEST_PATTERN, type Digest } from '../domain/types.ts';
import type { ArtifactRef, ArtifactStore } from '../storage/artifacts.ts';
import type { BackendHandle, FileReadResult, InstantBackend } from '../backends/types.ts';

const ARTIFACT_URI_PATTERN = /^artifact:\/\/(sha256:[0-9a-f]{64})$/;
const MAX_RAW_BYTES = 384 * 1024;
const MAX_TEXT_RESPONSE_BYTES = 512 * 1024;

const shellArgsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('exec'),
    command: z.string().min(1).max(128 * 1024),
    workdir: z.string().max(4096).optional(),
    tty: z.boolean().optional(),
    yield_time_ms: z.number().int().min(250).max(30_000).optional(),
    timeout_ms: z.number().int().min(0).max(86_400_000).optional(),
    max_output_tokens: z.number().int().min(1).max(262_144).optional(),
  }).strict(),
  z.object({
    action: z.literal('write'),
    session_id: z.string().uuid(),
    chars: z.string().max(64 * 1024),
    yield_time_ms: z.number().int().min(250).max(300_000).optional(),
    max_output_tokens: z.number().int().min(1).max(262_144).optional(),
  }).strict(),
  z.object({
    action: z.literal('poll'),
    session_id: z.string().uuid(),
    yield_time_ms: z.number().int().min(5_000).max(300_000).optional(),
    max_output_tokens: z.number().int().min(1).max(262_144).optional(),
  }).strict(),
  z.object({ action: z.literal('kill'), session_id: z.string().uuid() }).strict(),
]);

const readSchema = z.object({
  path: z.string().min(1).max(4096),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(10_000).optional(),
  ranges: z.array(z.object({
    start: z.number().int().min(1),
    end: z.number().int().min(1),
  }).strict()).max(10).optional(),
  cursor: z.string().max(1024).optional(),
  raw: z.boolean().optional(),
}).strict();

const writeSchema = z.object({
  path: z.string().min(1).max(4096),
  content: z.string().max(10 * 1024 * 1024),
  create_parents: z.boolean().optional(),
}).strict();

const editSchema = z.object({
  path: z.string().min(1).max(4096),
  expected_digest: z.string().regex(DIGEST_PATTERN),
  edits: z.array(z.object({
    kind: z.enum(['replace', 'insert_before', 'insert_after', 'delete']),
    start_line: z.number().int().min(1),
    end_line: z.number().int().min(1).optional(),
    content: z.string().optional(),
  }).strict()).min(1).max(100),
}).strict();

const globSchema = z.object({
  pattern: z.string().min(1).max(1024),
  cursor: z.string().max(1024).optional(),
  limit: z.number().int().min(1).max(10_000).optional(),
  gitignore: z.boolean().optional(),
  hidden: z.boolean().optional(),
  sort: z.enum(['name', 'modified']).optional(),
}).strict();

const grepSchema = z.object({
  pattern: z.string().min(1).max(4096),
  paths: z.array(z.string().min(1).max(4096)).max(50).optional(),
  cursor: z.string().max(1024).optional(),
  limit: z.number().int().min(1).max(10_000).optional(),
  case_sensitive: z.boolean().optional(),
  context_before: z.number().int().min(0).max(10).optional(),
  context_after: z.number().int().min(0).max(10).optional(),
  gitignore: z.boolean().optional(),
}).strict();

const moveSchema = z.object({
  source: z.string().min(1).max(4096),
  destination: z.string().min(1).max(4096),
}).strict();

const removeSchema = z.object({ path: z.string().min(1).max(4096) }).strict();
const artifactExportSchema = z.object({
  path: z.string().min(1).max(4096),
  media_type: z.string().min(1).max(256).optional(),
  filename: z.string().min(1).max(255).optional(),
}).strict();

const artifactMaterializeSchema = z.object({
  artifact: z.string().regex(/^artifact:\/\/sha256:[0-9a-f]{64}$/),
  path: z.string().min(1).max(4096),
  create_parents: z.boolean().optional(),
}).strict();

export interface McpDependencies {
  service: SandboxService;
  sessions: SessionManager;
  artifactStore: ArtifactStore;
  turn?: BoundTurn;
}

interface FileContext {
  turn: BoundTurn;
  backend: InstantBackend;
  handle: BackendHandle;
}

interface ReadArguments {
  path: string;
  offset?: number | undefined;
  limit?: number | undefined;
  ranges?: Array<{ start: number; end: number }> | undefined;
  cursor?: string | undefined;
  raw?: boolean | undefined;
}

interface StreamLinesResult {
  lines: string[];
  startLine: number;
  nextLine?: number;
}

function toolSuccess(result: object) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    structuredContent: result as Record<string, unknown>,
  };
}

function toolError(error: unknown) {
  const serviceError = error instanceof ServiceError
    ? error
    : new ServiceError('BACKEND_ERROR', error instanceof Error ? error.message : String(error));
  const body = {
    code: serviceError.code,
    message: serviceError.message,
    ...(serviceError.details === undefined ? {} : { details: serviceError.details }),
  };
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

function requireTurn(dependencies: McpDependencies): BoundTurn {
  if (!dependencies.turn) throw new ServiceError('TURN_CLOSED', 'Tool call is not bound to an open turn');
  return dependencies.turn;
}

function fileContext(dependencies: McpDependencies): FileContext {
  const turn = requireTurn(dependencies);
  const { instance, handle } = dependencies.service.getTurnHandle(turn.instanceId);
  return { turn, handle, backend: dependencies.service.backends.get(instance.backend) };
}

export function normalizeWorkspacePath(path: string, allowRoot = true): string {
  if (path.includes('\0') || path.includes('://')) throw new ServiceError('INVALID_ARGUMENT', 'Path is invalid');
  let normalized = path;
  if (normalized === '.' || normalized === '/workspace') normalized = '';
  else if (normalized.startsWith('/workspace/')) normalized = normalized.slice('/workspace/'.length);
  else if (normalized.startsWith('/')) throw new ServiceError('INVALID_ARGUMENT', 'Absolute paths must be inside /workspace');
  if (normalized.length === 0) {
    if (allowRoot) return '';
    throw new ServiceError('INVALID_ARGUMENT', 'Workspace root is not valid for this operation');
  }
  if (normalized.split('/').some((component) => component.length === 0 || component === '.' || component === '..')) {
    throw new ServiceError('INVALID_ARGUMENT', 'Path contains an unsafe component');
  }
  return normalized;
}

function normalizeWorkspacePattern(pattern: string): string {
  if (pattern.includes('\0') || pattern.includes('://')) throw new ServiceError('INVALID_ARGUMENT', 'Pattern is invalid');
  let normalized = pattern;
  if (normalized === '.' || normalized === '/workspace') return '**/*';
  if (normalized.startsWith('/workspace/')) normalized = normalized.slice('/workspace/'.length);
  else if (normalized.startsWith('/')) throw new ServiceError('INVALID_ARGUMENT', 'Absolute patterns must be inside /workspace');
  if (normalized.length === 0 || normalized.split('/').some((component) => component.length === 0 || component === '.' || component === '..')) {
    throw new ServiceError('INVALID_ARGUMENT', 'Pattern contains an unsafe component');
  }
  return normalized;
}

function parseArtifactUri(path: string): Digest | undefined {
  const match = ARTIFACT_URI_PATTERN.exec(path);
  return match?.[1] as Digest | undefined;
}

function cursorLine(cursor: string | undefined): number | undefined {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { nextLine?: unknown };
    return typeof value.nextLine === 'number' && Number.isSafeInteger(value.nextLine) && value.nextLine > 0
      ? value.nextLine
      : undefined;
  } catch {
    return undefined;
  }
}

function lineNumbers(lines: string[], startLine: number, ranges?: Array<{ start: number; end: number }>) {
  if (!ranges) return lines.map((text, index) => ({ line: startLine + index, text }));
  const output: Array<{ line: number; text: string }> = [];
  let current = startLine;
  for (const text of lines) {
    while (!ranges.some((range) => current >= range.start && current <= range.end)) current += 1;
    output.push({ line: current, text });
    current += 1;
  }
  return output;
}

function looksBinary(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

function mediaTypeForPath(path: string, binary: boolean): string {
  if (binary || /\.(?:bin|png|jpe?g|gif|webp|pdf|zip|gz|tgz|wasm|sqlite|db)$/i.test(path)) return 'application/octet-stream';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.html')) return 'text/html';
  if (path.endsWith('.css')) return 'text/css';
  if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) return 'text/javascript';
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'text/typescript';
  return 'text/plain';
}

function isTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith('text/')
    || mediaType === 'application/json'
    || mediaType === 'application/javascript'
    || mediaType === 'application/xml';
}

function streamWorkspaceFile(backend: InstantBackend, handle: FileContext['handle'], path: string, size: number) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= size) {
        controller.close();
        return;
      }
      const result = await backend.fileReadBytes(handle, { path, offset, limit: MAX_RAW_BYTES });
      if (result.size !== size || result.data.byteLength === 0) {
        controller.error(new ServiceError('BACKEND_ERROR', 'Workspace file changed during artifact export'));
        return;
      }
      offset += result.data.byteLength;
      controller.enqueue(result.data);
      if (result.eof) controller.close();
    },
  });
}

async function exportWorkspaceArtifact(
  dependencies: McpDependencies,
  context: FileContext,
  path: string,
  mediaType: string,
  filename?: string,
): Promise<ArtifactRef> {
  const stat = await context.backend.fileStat(context.handle, { path });
  if (stat.type !== 'file') throw new ServiceError('INVALID_ARGUMENT', 'Only regular files can be exported as artifacts');
  const source = streamWorkspaceFile(context.backend, context.handle, path, stat.size);
  return dependencies.artifactStore.putStream(context.turn.threadId, source, {
    mediaType,
    filename: filename ?? basename(path),
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function selectedLine(
  line: number,
  startLine: number,
  ranges: Array<{ start: number; end: number }> | undefined,
): boolean {
  if (line < startLine) return false;
  return !ranges || ranges.some((range) => line >= range.start && line <= range.end);
}

async function streamArtifactLines(
  store: ArtifactStore,
  threadId: string,
  digest: Digest,
  args: ReadArguments,
): Promise<StreamLinesResult | undefined> {
  if (args.ranges && (args.offset !== undefined || args.limit !== undefined)) {
    throw new ServiceError('INVALID_ARGUMENT', 'ranges cannot be combined with offset or limit');
  }
  const ranges = args.ranges ? [...args.ranges].sort((left, right) => left.start - right.start) : undefined;
  if (ranges?.some((range) => range.end < range.start)) throw new ServiceError('INVALID_ARGUMENT', 'Line range is invalid');
  const startLine = cursorLine(args.cursor) ?? ranges?.[0]?.start ?? args.offset ?? 1;
  const maximumLines = ranges ? Number.POSITIVE_INFINITY : args.limit ?? 200;
  const opened = await store.open(threadId, digest);
  const reader = opened.stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const lines: string[] = [];
  let pending = '';
  let lineNumber = 0;
  let nextLine: number | undefined;
  let binary = false;
  const accept = (line: string): boolean => {
    lineNumber += 1;
    if (!selectedLine(lineNumber, startLine, ranges)) return true;
    if (lines.length >= maximumLines || Buffer.byteLength(JSON.stringify([...lines, line])) > MAX_TEXT_RESPONSE_BYTES) {
      nextLine ??= lineNumber;
      return false;
    }
    lines.push(line);
    return true;
  };
  try {
    outer: while (true) {
      const next = await reader.read();
      if (next.done) break;
      try {
        pending += decoder.decode(next.value, { stream: true });
      } catch {
        binary = true;
        break;
      }
      while (true) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const line = pending.slice(0, newline + 1);
        pending = pending.slice(newline + 1);
        if (!accept(line)) break outer;
      }
    }
    if (!binary && nextLine === undefined) {
      try {
        pending += decoder.decode();
      } catch {
        binary = true;
      }
      if (!binary && pending.length > 0) accept(pending);
    }
  } finally {
    if (binary || nextLine !== undefined) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return binary ? undefined : { lines, startLine, ...(nextLine !== undefined ? { nextLine } : {}) };
}

function workspaceReadResult(path: string, result: FileReadResult, args: ReadArguments) {
  if (result.isDirectory) {
    return {
      path,
      entries: (result.entries ?? []).map((entry) => ({
        path: entry.path,
        type: entry.type,
        ...(entry.size !== undefined ? { size: entry.size } : {}),
        ...(entry.modifiedAt !== undefined ? { modified_at: entry.modifiedAt } : {}),
      })),
      is_directory: true,
      truncated: result.truncated,
      ...(result.nextCursor ? { next_cursor: result.nextCursor } : {}),
    };
  }
  const startLine = cursorLine(args.cursor) ?? args.ranges?.[0]?.start ?? args.offset ?? 1;
  const common = {
    path,
    size: result.size,
    digest: result.digest,
    truncated: result.truncated,
    media_type: 'text/plain',
    ...(result.nextOffset !== undefined ? { next_offset: result.nextOffset } : {}),
    ...(result.nextCursor ? { next_cursor: result.nextCursor } : {}),
  };
  return args.ranges
    ? { ...common, lines: lineNumbers(result.lines ?? [], startLine, args.ranges) }
    : { ...common, content: (result.lines ?? []).join(''), offset: startLine };
}

async function readArtifact(dependencies: McpDependencies, turn: BoundTurn, digest: Digest, args: ReadArguments) {
  const artifact = await dependencies.artifactStore.resolve(turn.threadId, digest);
  if (args.raw) {
    const offset = (args.offset ?? 1) - 1;
    const limit = Math.min(args.limit ?? 10_000, MAX_RAW_BYTES);
    const opened = await dependencies.artifactStore.open(turn.threadId, digest, { offset, limit });
    const bytes = await readAll(opened.stream);
    return {
      path: `artifact://${digest}`,
      content: bytes.toString('base64'),
      encoding: 'base64',
      size: artifact.sizeBytes,
      digest,
      offset: offset + 1,
      next_offset: offset + bytes.byteLength < artifact.sizeBytes ? offset + bytes.byteLength + 1 : undefined,
      truncated: offset + bytes.byteLength < artifact.sizeBytes,
      media_type: artifact.mediaType,
      artifact: `artifact://${digest}`,
    };
  }
  if (!isTextMediaType(artifact.mediaType)) {
    return {
      path: `artifact://${digest}`,
      artifact: `artifact://${digest}`,
      size: artifact.sizeBytes,
      digest,
      truncated: false,
      media_type: artifact.mediaType,
    };
  }
  const prefix = await dependencies.artifactStore.open(turn.threadId, digest, {
    offset: 0,
    limit: Math.min(8192, artifact.sizeBytes),
  });
  const prefixBytes = await readAll(prefix.stream);
  if (looksBinary(prefixBytes)) {
    return {
      path: `artifact://${digest}`,
      artifact: `artifact://${digest}`,
      size: artifact.sizeBytes,
      digest,
      truncated: false,
      media_type: artifact.mediaType,
    };
  }
  const text = await streamArtifactLines(dependencies.artifactStore, turn.threadId, digest, args);
  if (!text) {
    return {
      path: `artifact://${digest}`,
      artifact: `artifact://${digest}`,
      size: artifact.sizeBytes,
      digest,
      truncated: false,
      media_type: artifact.mediaType,
    };
  }
  const common = {
    path: `artifact://${digest}`,
    artifact: `artifact://${digest}`,
    size: artifact.sizeBytes,
    digest,
    truncated: text.nextLine !== undefined,
    media_type: artifact.mediaType,
    ...(text.nextLine !== undefined ? { next_cursor: Buffer.from(JSON.stringify({ nextLine: text.nextLine })).toString('base64url') } : {}),
  };
  return args.ranges
    ? { ...common, lines: lineNumbers(text.lines, text.startLine, args.ranges) }
    : { ...common, content: text.lines.join(''), offset: text.startLine, ...(text.nextLine !== undefined ? { next_offset: text.nextLine } : {}) };
}

async function handleRead(dependencies: McpDependencies, args: ReadArguments) {
  const turn = requireTurn(dependencies);
  const artifactDigest = parseArtifactUri(args.path);
  if (artifactDigest) return readArtifact(dependencies, turn, artifactDigest, args);
  if (args.path.startsWith('artifact://')) throw new ServiceError('INVALID_ARGUMENT', 'Artifact URI is invalid');
  const context = fileContext(dependencies);
  const path = normalizeWorkspacePath(args.path, true);
  const stat = await context.backend.fileStat(context.handle, { path });
  if (stat.type === 'directory') {
    const result = await context.backend.fileRead(context.handle, {
      path,
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.cursor ? { cursor: args.cursor } : {}),
    });
    return workspaceReadResult(path, result, args);
  }
  if (args.raw) {
    if (stat.size > (args.limit ?? 10_000)) {
      const artifact = await exportWorkspaceArtifact(dependencies, context, path, mediaTypeForPath(path, true));
      return { path, artifact: `artifact://${artifact.digest}`, size: artifact.sizeBytes, digest: artifact.digest, truncated: false, media_type: artifact.mediaType };
    }
    const raw = await context.backend.fileReadBytes(context.handle, { path, offset: 0, limit: Math.min(stat.size || 1, MAX_RAW_BYTES) });
    return {
      path,
      content: Buffer.from(raw.data).toString('base64'),
      encoding: 'base64',
      size: raw.size,
      digest: digestBytes(raw.data),
      offset: 1,
      truncated: !raw.eof,
      media_type: mediaTypeForPath(path, true),
    };
  }
  const prefix = await context.backend.fileReadBytes(context.handle, {
    path,
    offset: 0,
    limit: Math.max(1, Math.min(8192, stat.size)),
  });
  const mediaType = mediaTypeForPath(path, looksBinary(prefix.data));
  if (!isTextMediaType(mediaType)) {
    const artifact = await exportWorkspaceArtifact(dependencies, context, path, mediaType);
    return { path, artifact: `artifact://${artifact.digest}`, size: artifact.sizeBytes, digest: artifact.digest, truncated: false, media_type: artifact.mediaType };
  }
  const result = await context.backend.fileRead(context.handle, {
    path,
    ...(args.offset !== undefined ? { offset: args.offset } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.ranges ? { ranges: args.ranges } : {}),
    ...(args.cursor ? { cursor: args.cursor } : {}),
  });
  return workspaceReadResult(path, result, args);
}

function digestBytes(bytes: Uint8Array): Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}` as Digest;
}

export function buildMcpServer(dependencies: McpDependencies): McpServer {
  const server = new McpServer({ name: 'electrosphere', version: '0.1.0' });

  server.registerTool('shell', {
    title: 'Sandbox shell',
    description: 'Execute and control shell commands in the current turn runtime.',
    inputSchema: shellArgsSchema,
  }, async (args) => {
    try {
      const turn = requireTurn(dependencies);
      if (args.action === 'exec') {
        const relativeWorkdir = normalizeWorkspacePath(args.workdir ?? '/workspace', true);
        const result = await dependencies.sessions.exec({
          instanceId: turn.instanceId,
          command: args.command,
          workdir: relativeWorkdir ? `/workspace/${relativeWorkdir}` : '/workspace',
          ...(args.tty !== undefined ? { tty: args.tty } : {}),
          yieldTimeMs: args.yield_time_ms ?? 10_000,
          timeoutMs: args.timeout_ms ?? 0,
          ...(args.max_output_tokens !== undefined ? { maxOutputTokens: args.max_output_tokens } : {}),
        });
        return toolSuccess(result);
      }
      if (args.action === 'poll') {
        const result = await dependencies.sessions.poll({
          instanceId: turn.instanceId,
          sessionId: args.session_id,
          yieldTimeMs: args.yield_time_ms ?? 10_000,
          ...(args.max_output_tokens !== undefined ? { maxOutputTokens: args.max_output_tokens } : {}),
        });
        return toolSuccess(result);
      }
      if (args.action === 'write') {
        const result = await dependencies.sessions.write({
          instanceId: turn.instanceId,
          sessionId: args.session_id,
          chars: args.chars,
          yieldTimeMs: args.yield_time_ms ?? 10_000,
          ...(args.max_output_tokens !== undefined ? { maxOutputTokens: args.max_output_tokens } : {}),
        });
        return toolSuccess(result);
      }
      return toolSuccess(await dependencies.sessions.kill({ instanceId: turn.instanceId, sessionId: args.session_id }));
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('read', {
    title: 'Read file',
    description: 'Read text, bytes, directories, or a granted artifact from the current turn.',
    inputSchema: readSchema,
  }, async (args) => {
    try {
      return toolSuccess(await handleRead(dependencies, args));
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('write', {
    title: 'Write file',
    description: 'Atomically write UTF-8 content in the current turn workspace.',
    inputSchema: writeSchema,
  }, async (args) => {
    try {
      const context = fileContext(dependencies);
      const path = normalizeWorkspacePath(args.path, false);
      const bytes = new TextEncoder().encode(args.content);
      const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
      const result = await context.backend.fileWrite(context.handle, { path, source, createParents: args.create_parents ?? false });
      return toolSuccess({ path, size: result.size, digest: result.digest });
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('edit', {
    title: 'Edit file',
    description: 'Apply line edits with optimistic digest concurrency control.',
    inputSchema: editSchema,
  }, async (args) => {
    try {
      const context = fileContext(dependencies);
      const path = normalizeWorkspacePath(args.path, false);
      const result = await context.backend.fileEdit(context.handle, {
        path,
        expectedDigest: args.expected_digest as Digest,
        edits: args.edits.map((edit) => ({
          kind: edit.kind,
          startLine: edit.start_line,
          ...(edit.end_line !== undefined ? { endLine: edit.end_line } : {}),
          ...(edit.content !== undefined ? { content: edit.content } : {}),
        })),
      });
      return toolSuccess({ path, lines_before: result.linesBefore, lines_after: result.linesAfter, digest: result.digest });
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('glob', {
    title: 'Glob files',
    description: 'List files and directories matching one or more workspace glob patterns.',
    inputSchema: globSchema,
  }, async (args) => {
    try {
      const context = fileContext(dependencies);
      const patterns = args.pattern.split(';').map((pattern) => pattern.trim()).filter(Boolean).map(normalizeWorkspacePattern);
      if (patterns.length === 0) throw new ServiceError('INVALID_ARGUMENT', 'Glob pattern is empty');
      const result = await context.backend.fileGlob(context.handle, {
        patterns,
        ...(args.cursor ? { cursor: args.cursor } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.gitignore !== undefined ? { gitignore: args.gitignore } : {}),
        ...(args.hidden !== undefined ? { hidden: args.hidden } : {}),
        ...(args.sort ? { sort: args.sort } : {}),
      });
      return toolSuccess({
        entries: result.entries.map((entry) => ({
          path: entry.path,
          type: entry.type,
          ...(entry.size !== undefined ? { size: entry.size } : {}),
          ...(entry.modifiedAt !== undefined ? { modified_at: entry.modifiedAt } : {}),
        })),
        truncated: result.truncated,
        ...(result.nextCursor ? { next_cursor: result.nextCursor } : {}),
      });
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('grep', {
    title: 'Search files',
    description: 'Search current-turn workspace files with Rust regex and bounded PCRE2 fallback.',
    inputSchema: grepSchema,
  }, async (args) => {
    try {
      const context = fileContext(dependencies);
      const paths = args.paths?.map((path) => normalizeWorkspacePath(path, true));
      const result = await context.backend.fileGrep(context.handle, {
        pattern: args.pattern,
        ...(paths ? { paths } : {}),
        ...(args.cursor ? { cursor: args.cursor } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.case_sensitive !== undefined ? { caseSensitive: args.case_sensitive } : {}),
        ...(args.context_before !== undefined ? { contextBefore: args.context_before } : {}),
        ...(args.context_after !== undefined ? { contextAfter: args.context_after } : {}),
        ...(args.gitignore !== undefined ? { gitignore: args.gitignore } : {}),
      });
      return toolSuccess({
        matches: result.matches.map((match) => ({
          path: match.path,
          line: match.line,
          text: match.text,
          ...(match.contextBefore ? { context_before: match.contextBefore } : {}),
          ...(match.contextAfter ? { context_after: match.contextAfter } : {}),
        })),
        total_matches: result.totalMatches,
        skipped_files: result.skippedFiles,
        truncated: result.truncated,
        ...(result.nextCursor ? { next_cursor: result.nextCursor } : {}),
      });
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('move', {
    title: 'Move file',
    description: 'Atomically move a file or directory within the current turn workspace.',
    inputSchema: moveSchema,
  }, async (args) => {
    try {
      const context = fileContext(dependencies);
      const source = normalizeWorkspacePath(args.source, false);
      const destination = normalizeWorkspacePath(args.destination, false);
      await context.backend.fileMove(context.handle, { source, destination });
      return toolSuccess({ source, destination });
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('remove', {
    title: 'Remove file',
    description: 'Remove a file, symlink, or directory tree from the current turn workspace.',
    inputSchema: removeSchema,
  }, async (args) => {
    try {
      const context = fileContext(dependencies);
      const path = normalizeWorkspacePath(args.path, false);
      await context.backend.fileRemove(context.handle, { path });
      return toolSuccess({ path, removed: true });
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('artifact_export', {
    title: 'Export artifact',
    description: 'Stream a regular file from the current turn into the thread-scoped artifact store.',
    inputSchema: artifactExportSchema,
  }, async (args) => {
    try {
      const context = fileContext(dependencies);
      const path = normalizeWorkspacePath(args.path, false);
      const stat = await context.backend.fileStat(context.handle, { path });
      if (stat.type !== 'file') throw new ServiceError('INVALID_ARGUMENT', 'Only regular files can be exported as artifacts');
      const prefix = await context.backend.fileReadBytes(context.handle, {
        path,
        offset: 0,
        limit: Math.max(1, Math.min(8192, stat.size)),
      });
      const mediaType = args.media_type ?? mediaTypeForPath(path, looksBinary(prefix.data));
      const artifact = await exportWorkspaceArtifact(dependencies, context, path, mediaType, args.filename);
      return toolSuccess({
        uri: `artifact://${artifact.digest}`,
        digest: artifact.digest,
        size: artifact.sizeBytes,
        media_type: artifact.mediaType,
      });
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('artifact_materialize', {
    title: 'Materialize artifact',
    description: 'Stream a thread-granted artifact into the current turn workspace.',
    inputSchema: artifactMaterializeSchema,
  }, async (args) => {
    try {
      const context = fileContext(dependencies);
      const digest = parseArtifactUri(args.artifact);
      if (!digest) throw new ServiceError('INVALID_ARGUMENT', 'Artifact URI is invalid');
      const path = normalizeWorkspacePath(args.path, false);
      const opened = await dependencies.artifactStore.open(context.turn.threadId, digest);
      const result = await context.backend.fileWrite(context.handle, {
        path,
        source: opened.stream,
        createParents: args.create_parents ?? false,
      });
      return toolSuccess({ path, size: result.size, digest: result.digest });
    } catch (error) {
      return toolError(error);
    }
  });

  return server;
}
