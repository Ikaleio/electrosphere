import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportCfs, extractCfs } from '../src/storage/cfs.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'cfs-test-'));
  roots.push(path);
  return path;
}

function cfsEntry(path: string, type: number, payload = Buffer.alloc(0), mode = 0o644): Buffer {
  const pathBytes = Buffer.from(path);
  const header = Buffer.alloc(4 + pathBytes.length + 1 + 4 + 8 + 8);
  let offset = 0;
  header.writeUInt32BE(pathBytes.length, offset);
  offset += 4;
  pathBytes.copy(header, offset);
  offset += pathBytes.length;
  header[offset] = type;
  offset += 1;
  header.writeUInt32BE(mode, offset);
  offset += 4;
  header.writeBigUInt64BE(1_700_000_000_000_000_000n, offset);
  offset += 8;
  header.writeBigUInt64BE(BigInt(payload.length), offset);
  return Buffer.concat([header, payload]);
}

describe('CFS-v1', () => {
  test('round-trips regular files, mode, Unicode, symlinks, hard links, and digest', async () => {
    const base = await root();
    const source = join(base, 'source');
    const objects = join(base, 'objects', 'trees');
    const restored = join(base, 'restored');
    await mkdir(join(source, '目录'), { recursive: true });
    await writeFile(join(source, 'run.sh'), '#!/bin/sh\nprintf ok');
    await chmod(join(source, 'run.sh'), 0o755);
    await writeFile(join(source, '目录', '文件.txt'), 'payload');
    await link(join(source, '目录', '文件.txt'), join(source, 'hard.txt'));
    await symlink('目录/文件.txt', join(source, 'soft.txt'));
    const seconds = 1_700_000_000;
    await utimes(join(source, 'run.sh'), seconds, seconds);
    await utimes(join(source, '目录', '文件.txt'), seconds, seconds);
    await utimes(join(source, 'hard.txt'), seconds, seconds);
    await utimes(join(source, '目录'), seconds, seconds);
    await utimes(source, seconds, seconds);

    const first = await exportCfs(source, objects);
    await extractCfs(first.path, restored);
    const second = await exportCfs(restored, objects);

    expect(second.treeDigest).toBe(first.treeDigest);
    expect(await readFile(join(restored, '目录', '文件.txt'), 'utf8')).toBe('payload');
    expect((await lstat(join(restored, 'run.sh'))).mode & 0o777).toBe(0o755);
    expect(await readlink(join(restored, 'soft.txt'))).toBe('目录/文件.txt');
    const original = await lstat(join(restored, '目录', '文件.txt'));
    const hard = await lstat(join(restored, 'hard.txt'));
    expect(hard.ino).toBe(original.ino);
  });

  test('rejects FIFO and setuid entries', async () => {
    const base = await root();
    const source = join(base, 'source');
    await mkdir(source);
    const fifo = Bun.spawn(['mkfifo', join(source, 'pipe')]);
    expect(await fifo.exited).toBe(0);
    await expect(exportCfs(source, join(base, 'objects'))).rejects.toMatchObject({ code: 'SNAPSHOT_UNSUPPORTED_ENTRY' });

    const setuid = join(base, 'setuid.cfs');
    await writeFile(setuid, Buffer.concat([Buffer.from('CFS-v1\0'), cfsEntry('setuid', 2, Buffer.from('x'), 0o4755)]));
    await expect(extractCfs(setuid, join(base, 'workspace-setuid'))).rejects.toMatchObject({ code: 'SNAPSHOT_UNSUPPORTED_ENTRY' });
  });

  test('rejects path and symlink traversal during extraction', async () => {
    const base = await root();
    const unsafePath = join(base, 'unsafe-path.cfs');
    await writeFile(unsafePath, Buffer.concat([Buffer.from('CFS-v1\0'), cfsEntry('../escape', 2, Buffer.from('x'))]));
    await expect(extractCfs(unsafePath, join(base, 'workspace-a'))).rejects.toMatchObject({ code: 'SNAPSHOT_UNSUPPORTED_ENTRY' });

    const unsafeLink = join(base, 'unsafe-link.cfs');
    await writeFile(unsafeLink, Buffer.concat([Buffer.from('CFS-v1\0'), cfsEntry('link', 3, Buffer.from('../../escape'))]));
    await expect(extractCfs(unsafeLink, join(base, 'workspace-b'))).rejects.toMatchObject({ code: 'SNAPSHOT_UNSUPPORTED_ENTRY' });
  });
});
