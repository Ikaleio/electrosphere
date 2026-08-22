import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readdir, readlink } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { ServiceError } from '../domain/errors.ts';

interface TarEntry {
  absolute: string;
  path: string;
  stats: BigIntStats;
}

function octal(value: number | bigint, width: number): Buffer {
  const encoded = BigInt(value).toString(8).padStart(width - 1, '0');
  if (encoded.length >= width) throw new ServiceError('SNAPSHOT_LIMIT', 'Tar numeric field exceeds format limit');
  return Buffer.from(`${encoded}\0`, 'ascii');
}

function writeField(header: Buffer, offset: number, width: number, value: Buffer): void {
  if (value.length > width) throw new ServiceError('SNAPSHOT_UNSUPPORTED_ENTRY', 'Tar field exceeds format limit');
  value.copy(header, offset);
}

function tarHeader(input: { name: string; mode: number; size: bigint; mtime: bigint; type: string; linkName?: string }): Buffer {
  const header = Buffer.alloc(512);
  const name = Buffer.from(input.name, 'utf8');
  const linkName = Buffer.from(input.linkName ?? '', 'utf8');
  if (name.length > 100 || linkName.length > 100) throw new ServiceError('SNAPSHOT_UNSUPPORTED_ENTRY', 'Tar path exceeds ustar field limit');
  writeField(header, 0, 100, name);
  writeField(header, 100, 8, octal(input.mode & 0o7777, 8));
  writeField(header, 108, 8, octal(1000, 8));
  writeField(header, 116, 8, octal(1000, 8));
  writeField(header, 124, 12, octal(input.size, 12));
  writeField(header, 136, 12, octal(input.mtime, 12));
  header.fill(0x20, 148, 156);
  header.write(input.type, 156, 1, 'ascii');
  writeField(header, 157, 100, linkName);
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write('code', 265, 4, 'ascii');
  header.write('code', 297, 4, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumBytes = Buffer.from(`${checksum.toString(8).padStart(6, '0')}\0 `, 'ascii');
  checksumBytes.copy(header, 148);
  return header;
}

async function collect(root: string): Promise<TarEntry[]> {
  const entries: TarEntry[] = [];
  const walk = async (directory: string): Promise<void> => {
    const names = await readdir(directory, { encoding: 'utf8' });
    names.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    for (const name of names) {
      const absolute = join(directory, name);
      const path = relative(root, absolute).split(sep).join('/');
      if (path.length === 0 || path.startsWith('/') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
        throw new ServiceError('SNAPSHOT_UNSUPPORTED_ENTRY', `Unsafe archive path: ${path}`);
      }
      const stats = await lstat(absolute, { bigint: true });
      entries.push({ absolute, path, stats });
      if (stats.isDirectory()) await walk(absolute);
    }
  };
  await walk(root);
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return entries;
}

async function* chunks(root: string): AsyncGenerator<Uint8Array> {
  const hardLinks = new Map<string, string>();
  for (const entry of await collect(root)) {
    const mode = Number(entry.stats.mode) & 0o7777;
    const mtime = entry.stats.mtimeNs / 1_000_000_000n;
    if (entry.stats.isDirectory()) {
      yield tarHeader({ name: `${entry.path}/`, mode, size: 0n, mtime, type: '5' });
      continue;
    }
    if (entry.stats.isSymbolicLink()) {
      const target = await readlink(entry.absolute, 'utf8');
      yield tarHeader({ name: entry.path, mode, size: 0n, mtime, type: '2', linkName: target });
      continue;
    }
    if (!entry.stats.isFile()) throw new ServiceError('SNAPSHOT_UNSUPPORTED_ENTRY', `Unsupported archive entry: ${entry.path}`);
    const inode = `${entry.stats.dev}:${entry.stats.ino}`;
    const prior = entry.stats.nlink > 1n ? hardLinks.get(inode) : undefined;
    if (prior) {
      yield tarHeader({ name: entry.path, mode, size: 0n, mtime, type: '1', linkName: prior });
      continue;
    }
    if (entry.stats.nlink > 1n) hardLinks.set(inode, entry.path);
    yield tarHeader({ name: entry.path, mode, size: entry.stats.size, mtime, type: '0' });
    const file = await open(entry.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let offset = 0n;
      while (offset < entry.stats.size) {
        const length = Number((entry.stats.size - offset) > BigInt(buffer.length) ? BigInt(buffer.length) : entry.stats.size - offset);
        const { bytesRead } = await file.read(buffer, 0, length, Number(offset));
        if (bytesRead === 0) break;
        yield buffer.subarray(0, bytesRead);
        offset += BigInt(bytesRead);
      }
      if (offset !== entry.stats.size) throw new ServiceError('BACKEND_ERROR', `File changed during archive: ${entry.path}`);
    } finally {
      await file.close();
    }
    const padding = Number((512n - (entry.stats.size % 512n)) % 512n);
    if (padding > 0) yield Buffer.alloc(padding);
  }
  yield Buffer.alloc(1024);
}

export function workspaceTarStream(root: string): ReadableStream<Uint8Array> {
  const iterator = chunks(root)[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.(undefined);
    },
  });
}
