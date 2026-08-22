import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { chmod, link, lstat, lutimes, mkdir, open, readFile, readdir, readlink, rename, rm, stat, symlink, utimes } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Digest } from '../domain/types.ts';
import { ServiceError } from '../domain/errors.ts';

const MAGIC = Buffer.from('CFS-v1\0', 'utf8');
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_TREE_BYTES = 1024 * 1024 * 1024;
const TYPE_DIRECTORY = 1;
const TYPE_FILE = 2;
const TYPE_SYMLINK = 3;
const TYPE_HARDLINK = 4;

interface EntryHeader {
  path: string;
  type: number;
  mode: number;
  mtimeNs: bigint;
  payloadLength: number;
}

export interface CfsObject {
  treeDigest: Digest;
  path: string;
  sizeBytes: number;
}

function u32(value: number): Buffer {
  const out = Buffer.allocUnsafe(4);
  out.writeUInt32BE(value);
  return out;
}

function u64(value: bigint): Buffer {
  const out = Buffer.allocUnsafe(8);
  out.writeBigUInt64BE(value);
  return out;
}

function digest(bytes: Uint8Array | string): Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}` as Digest;
}

function validateRelativePath(path: string): void {
  if (path.length === 0 || path.includes('\0') || path.startsWith('/') || path.split('/').some((part) => part === '.' || part === '..' || part.length === 0)) {
    throw new ServiceError('SNAPSHOT_UNSUPPORTED_ENTRY', `Unsafe snapshot path: ${path}`);
  }
}

function encodeHeader(header: EntryHeader): Buffer {
  const pathBytes = Buffer.from(header.path, 'utf8');
  return Buffer.concat([
    u32(pathBytes.length),
    pathBytes,
    Buffer.from([header.type]),
    u32(header.mode),
    u64(header.mtimeNs),
    u64(BigInt(header.payloadLength)),
  ]);
}

async function collectEntries(root: string): Promise<Array<{ absolute: string; relative: string; stats: BigIntStats }>> {
  const entries: Array<{ absolute: string; relative: string; stats: BigIntStats }> = [];
  async function walk(directory: string): Promise<void> {
    const names = await readdir(directory, { encoding: 'utf8' });
    names.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    for (const name of names) {
      const absolute = join(directory, name);
      const relativePath = relative(root, absolute).split(sep).join('/');
      validateRelativePath(relativePath);
      const entryStats = await lstat(absolute, { bigint: true });
      entries.push({ absolute, relative: relativePath, stats: entryStats });
      if (entryStats.isDirectory()) await walk(absolute);
    }
  }
  await walk(root);
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.relative), Buffer.from(b.relative)));
  return entries;
}

export async function exportCfs(root: string, objectRoot: string): Promise<CfsObject> {
  const rootStats = await stat(root).catch(() => undefined);
  if (!rootStats?.isDirectory()) throw new ServiceError('INVALID_ARGUMENT', 'Workspace root does not exist');
  await mkdir(join(objectRoot, 'sha256'), { recursive: true, mode: 0o700 });
  const stagingDir = join(objectRoot, '..', '..', 'staging');
  await mkdir(stagingDir, { recursive: true, mode: 0o700 });
  const stagingPath = join(stagingDir, `${crypto.randomUUID()}.cfs`);
  const handle = await open(stagingPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  const hasher = createHash('sha256');
  let total = 0;
  const hardLinks = new Map<string, string>();
  const append = async (chunk: Uint8Array): Promise<void> => {
    total += chunk.byteLength;
    if (total > MAX_TREE_BYTES) throw new ServiceError('SNAPSHOT_LIMIT', 'Snapshot exceeds total size limit');
    hasher.update(chunk);
    await handle.write(chunk);
  };
  try {
    await append(MAGIC);
    for (const entry of await collectEntries(root)) {
      const mode = Number(entry.stats.mode) & 0o7777;
      if ((mode & 0o6000) !== 0) throw new ServiceError('SNAPSHOT_UNSUPPORTED_ENTRY', `setuid/setgid entry rejected: ${entry.relative}`);
      const mtimeNs = ((entry.stats.mtimeNs + 500_000n) / 1_000_000n) * 1_000_000n;
      if (entry.stats.isDirectory()) {
        await append(encodeHeader({ path: entry.relative, type: TYPE_DIRECTORY, mode, mtimeNs, payloadLength: 0 }));
      } else if (entry.stats.isSymbolicLink()) {
        const target = await readlink(entry.absolute, 'utf8');
        const resolvedTarget = resolve(dirname(entry.absolute), target);
        if (target.startsWith('/') || (resolvedTarget !== root && !resolvedTarget.startsWith(`${root}${sep}`))) {
          throw new ServiceError('SNAPSHOT_UNSUPPORTED_ENTRY', `Symlink target escapes workspace: ${entry.relative}`);
        }
        const payload = Buffer.from(target, 'utf8');
        await append(encodeHeader({ path: entry.relative, type: TYPE_SYMLINK, mode, mtimeNs, payloadLength: payload.length }));
        await append(payload);
      } else if (entry.stats.isFile()) {
        const size = Number(entry.stats.size);
        if (size > MAX_FILE_BYTES) throw new ServiceError('SNAPSHOT_LIMIT', `File exceeds size limit: ${entry.relative}`);
        const inodeKey = `${String(entry.stats.dev)}:${String(entry.stats.ino)}`;
        const linkTarget = entry.stats.nlink > 1n ? hardLinks.get(inodeKey) : undefined;
        if (linkTarget) {
          const payload = Buffer.from(linkTarget, 'utf8');
          await append(encodeHeader({ path: entry.relative, type: TYPE_HARDLINK, mode, mtimeNs, payloadLength: payload.length }));
          await append(payload);
        } else {
          if (entry.stats.nlink > 1n) hardLinks.set(inodeKey, entry.relative);
          await append(encodeHeader({ path: entry.relative, type: TYPE_FILE, mode, mtimeNs, payloadLength: size }));
          const input = await open(entry.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const buffer = Buffer.allocUnsafe(64 * 1024);
            let offset = 0;
            while (offset < size) {
              const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
              if (bytesRead === 0) break;
              await append(buffer.subarray(0, bytesRead));
              offset += bytesRead;
            }
            if (offset !== size) throw new ServiceError('BACKEND_ERROR', `File changed during snapshot: ${entry.relative}`);
          } finally {
            await input.close();
          }
        }
      } else {
        throw new ServiceError('SNAPSHOT_UNSUPPORTED_ENTRY', `Unsupported entry: ${entry.relative}`);
      }
    }
    await handle.sync();
    const treeDigest = `sha256:${hasher.digest('hex')}` as Digest;
    const finalPath = join(objectRoot, 'sha256', treeDigest.slice(7));
    await handle.close();
    await link(stagingPath, finalPath).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    await rm(stagingPath, { force: true });
    await chmod(finalPath, 0o400);
    return { treeDigest, path: finalPath, sizeBytes: total };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(stagingPath, { force: true });
    throw error;
  }
}

function readHeader(buffer: Buffer, offset: number): { header: EntryHeader; next: number } {
  if (offset + 4 > buffer.length) throw new ServiceError('BACKEND_ERROR', 'Truncated CFS path length');
  const pathLength = buffer.readUInt32BE(offset);
  offset += 4;
  if (offset + pathLength + 21 > buffer.length) throw new ServiceError('BACKEND_ERROR', 'Truncated CFS entry');
  const path = buffer.subarray(offset, offset + pathLength).toString('utf8');
  offset += pathLength;
  const type = buffer[offset] ?? 0;
  offset += 1;
  const mode = buffer.readUInt32BE(offset);
  offset += 4;
  const mtimeNs = buffer.readBigUInt64BE(offset);
  offset += 8;
  const payloadLengthBig = buffer.readBigUInt64BE(offset);
  offset += 8;
  if (payloadLengthBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new ServiceError('SNAPSHOT_LIMIT', 'CFS payload is too large');
  if ((mode & 0o6000) !== 0) throw new ServiceError('SNAPSHOT_UNSUPPORTED_ENTRY', `setuid/setgid entry rejected: ${path}`);
  validateRelativePath(path);
  return { header: { path, type, mode, mtimeNs, payloadLength: Number(payloadLengthBig) }, next: offset };
}

function safeDestination(root: string, relativePath: string): string {
  const destination = resolve(root, relativePath);
  if (destination !== root && !destination.startsWith(`${root}${sep}`)) throw new ServiceError('SNAPSHOT_UNSUPPORTED_ENTRY', 'CFS path escapes workspace');
  return destination;
}

function assertNoSymlinkAncestor(relativePath: string, entryTypes: Map<string, number>): void {
  const parts = relativePath.split('/');
  let ancestor = '';
  for (const part of parts.slice(0, -1)) {
    ancestor = ancestor.length === 0 ? part : `${ancestor}/${part}`;
    if (entryTypes.get(ancestor) === TYPE_SYMLINK) {
      throw new ServiceError('SNAPSHOT_UNSUPPORTED_ENTRY', `CFS path traverses symlink: ${relativePath}`);
    }
  }
}
export async function ingestCfs(sourcePath: string, objectRoot: string, expectedDigest?: Digest): Promise<CfsObject> {
  const bytes = await readFile(sourcePath);
  if (bytes.length > MAX_TREE_BYTES) throw new ServiceError('SNAPSHOT_LIMIT', 'Snapshot exceeds total size limit');
  const treeDigest = digest(bytes);
  if (expectedDigest && treeDigest !== expectedDigest) throw new ServiceError('BACKEND_ERROR', 'Guest snapshot digest mismatch');
  const validationRoot = join(objectRoot, '..', '..', 'staging', `validate-${crypto.randomUUID()}`);
  const validationWorkspace = join(validationRoot, 'workspace');
  await mkdir(validationRoot, { recursive: true, mode: 0o700 });
  try {
    await extractCfs(sourcePath, validationWorkspace);
  } finally {
    await rm(validationRoot, { recursive: true, force: true });
  }
  await mkdir(join(objectRoot, 'sha256'), { recursive: true, mode: 0o700 });
  const finalPath = join(objectRoot, 'sha256', treeDigest.slice(7));
  await link(sourcePath, finalPath).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') return;
    if (error.code !== 'EXDEV') throw error;
    const target = await open(finalPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o400);
    try {
      await target.write(bytes);
      await target.sync();
    } finally {
      await target.close();
    }
  });
  await chmod(finalPath, 0o400);
  return { treeDigest, path: finalPath, sizeBytes: bytes.length };
}


export async function extractCfs(objectPath: string, destination: string): Promise<void> {
  const bytes = await readFile(objectPath);
  if (!bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw new ServiceError('BACKEND_ERROR', 'Invalid CFS magic');
  const parent = dirname(destination);
  const staging = join(parent, `.staging-${crypto.randomUUID()}`);
  await mkdir(staging, { recursive: false, mode: 0o700 });
  let offset = MAGIC.length;
  const entryTypes = new Map<string, number>();
  const directoryTimes: Array<{ path: string; seconds: number }> = [];
  try {
    while (offset < bytes.length) {
      const decoded = readHeader(bytes, offset);
      const header = decoded.header;
      offset = decoded.next;
      if (offset + header.payloadLength > bytes.length) throw new ServiceError('BACKEND_ERROR', 'Truncated CFS payload');
      const payload = bytes.subarray(offset, offset + header.payloadLength);
      offset += header.payloadLength;
      assertNoSymlinkAncestor(header.path, entryTypes);
      const output = safeDestination(staging, header.path);
      await mkdir(dirname(output), { recursive: true, mode: 0o700 });
      if (header.type === TYPE_DIRECTORY) {
        await mkdir(output, { recursive: false, mode: header.mode & 0o777 });
        directoryTimes.push({ path: output, seconds: Number(header.mtimeNs) / 1_000_000_000 });
      } else if (header.type === TYPE_FILE) {
        const file = await open(output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, header.mode & 0o777);
        await file.write(payload);
        await file.sync();
        await file.close();
      } else if (header.type === TYPE_SYMLINK) {
        const target = payload.toString('utf8');
        if (target.includes('\0') || target.startsWith('/')) throw new ServiceError('SNAPSHOT_UNSUPPORTED_ENTRY', `Unsafe symlink target: ${header.path}`);
        const resolvedTarget = resolve(dirname(output), target);
        if (resolvedTarget !== staging && !resolvedTarget.startsWith(`${staging}${sep}`)) throw new ServiceError('SNAPSHOT_UNSUPPORTED_ENTRY', `Symlink target escapes workspace: ${header.path}`);
        await symlink(target, output);
        const seconds = Number(header.mtimeNs) / 1_000_000_000;
        await lutimes(output, seconds, seconds);
      } else if (header.type === TYPE_HARDLINK) {
        const target = payload.toString('utf8');
        validateRelativePath(target);
        if (entryTypes.get(target) !== TYPE_FILE) throw new ServiceError('SNAPSHOT_UNSUPPORTED_ENTRY', `Hard-link target is not a prior regular file: ${header.path}`);
        await link(safeDestination(staging, target), output);
      } else {
        throw new ServiceError('SNAPSHOT_UNSUPPORTED_ENTRY', `Unsupported CFS entry type: ${header.type}`);
      }
      if (header.type !== TYPE_SYMLINK) {
        await chmod(output, header.mode & 0o777);
        if (header.type !== TYPE_DIRECTORY) {
          const seconds = Number(header.mtimeNs) / 1_000_000_000;
          await utimes(output, seconds, seconds);
        }
      }
      entryTypes.set(header.path, header.type);
    }
    for (const directory of directoryTimes.reverse()) await utimes(directory.path, directory.seconds, directory.seconds);
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function materializeCfs(objectPath: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await extractCfs(objectPath, destination);
}

export function commitDigest(contractDigest: Digest, treeDigest: Digest, parentId?: Digest): Digest {
  return digest(`electrosphere-commit\0v1\0${contractDigest}\0${treeDigest}\0${parentId ?? ''}`);
}
