import { constants } from 'node:fs';
import { chmod, link, mkdir, open as openFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ServiceError } from '../domain/errors.ts';
import type { Digest } from '../domain/types.ts';
import type { Repository } from './repository.ts';

const STREAM_CHUNK_BYTES = 384 * 1024;

export interface ArtifactRef {
  digest: Digest;
  path: string;
  sizeBytes: number;
  mediaType: string;
}

export interface ArtifactStore {
  putStream(
    threadId: string,
    source: ReadableStream<Uint8Array>,
    metadata?: { mediaType?: string; filename?: string },
  ): Promise<ArtifactRef>;
  resolve(threadId: string, digest: Digest): Promise<ArtifactRef>;
  open(
    threadId: string,
    digest: Digest,
    range?: { offset: number; limit: number },
  ): Promise<{ stream: ReadableStream<Uint8Array>; sizeBytes: number; mediaType: string }>;
}

interface ArtifactMetadata {
  mediaType: string;
  filename?: string;
}

function parseMetadata(value: string): ArtifactMetadata {
  const metadata = JSON.parse(value) as Partial<ArtifactMetadata>;
  return {
    mediaType: typeof metadata.mediaType === 'string' ? metadata.mediaType : 'application/octet-stream',
    ...(typeof metadata.filename === 'string' ? { filename: metadata.filename } : {}),
  };
}

export class LocalArtifactStore implements ArtifactStore {
  constructor(
    private readonly root: string,
    private readonly repository: Repository,
  ) {}

  async putStream(
    threadId: string,
    source: ReadableStream<Uint8Array>,
    metadata: { mediaType?: string; filename?: string } = {},
  ): Promise<ArtifactRef> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = join(this.root, `.electrosphere-${crypto.randomUUID()}.tmp`);
    const file = await openFile(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    const reader = source.getReader();
    const hasher = createHash('sha256');
    let sizeBytes = 0;
    let destination: string | undefined;
    let installed = false;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (next.value.byteLength === 0) continue;
        await file.write(next.value);
        hasher.update(next.value);
        sizeBytes += next.value.byteLength;
      }
      await file.sync();
      await file.close();
      const digest = `sha256:${hasher.digest('hex')}` as Digest;
      destination = join(this.root, digest.slice('sha256:'.length));
      try {
        await link(temporary, destination);
        installed = true;
        await chmod(destination, 0o400);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      await rm(temporary, { force: true });
      const storedMetadata: ArtifactMetadata = {
        mediaType: metadata.mediaType ?? 'application/octet-stream',
        ...(metadata.filename ? { filename: metadata.filename } : {}),
      };
      this.repository.putArtifactAndGrant({
        threadId,
        digest,
        path: destination,
        sizeBytes,
        metadataJson: JSON.stringify(storedMetadata),
      });
      return this.resolve(threadId, digest);
    } catch (error) {
      await file.close().catch(() => undefined);
      await rm(temporary, { force: true });
      if (installed && destination) await rm(destination, { force: true });
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  async resolve(threadId: string, digest: Digest): Promise<ArtifactRef> {
    const row = this.repository.getGrantedArtifact(threadId, digest);
    if (!row) throw new ServiceError('NOT_FOUND', 'Artifact not found');
    const metadata = parseMetadata(row.metadataJson);
    const file = await stat(row.path).catch(() => undefined);
    if (!file?.isFile() || file.size !== row.sizeBytes) throw new ServiceError('BACKEND_ERROR', 'Artifact storage is inconsistent');
    return { digest: row.digest, path: row.path, sizeBytes: row.sizeBytes, mediaType: metadata.mediaType };
  }

  async open(
    threadId: string,
    digest: Digest,
    range?: { offset: number; limit: number },
  ): Promise<{ stream: ReadableStream<Uint8Array>; sizeBytes: number; mediaType: string }> {
    const artifact = await this.resolve(threadId, digest);
    const offset = range?.offset ?? 0;
    const limit = range?.limit ?? artifact.sizeBytes - offset;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > artifact.sizeBytes || !Number.isSafeInteger(limit) || limit < 0) {
      throw new ServiceError('INVALID_ARGUMENT', 'Artifact byte range is invalid');
    }
    const file = await openFile(artifact.path, constants.O_RDONLY);
    let position = offset;
    let remaining = Math.min(limit, artifact.sizeBytes - offset);
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await file.close();
    };
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (remaining === 0) {
          await close();
          controller.close();
          return;
        }
        const buffer = Buffer.allocUnsafe(Math.min(STREAM_CHUNK_BYTES, remaining));
        const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, position);
        if (bytesRead === 0) {
          await close();
          controller.error(new ServiceError('BACKEND_ERROR', 'Artifact ended before its recorded size'));
          return;
        }
        position += bytesRead;
        remaining -= bytesRead;
        controller.enqueue(buffer.subarray(0, bytesRead));
        if (remaining === 0) {
          await close();
          controller.close();
        }
      },
      async cancel() {
        await close();
      },
    });
    return { stream, sizeBytes: artifact.sizeBytes, mediaType: artifact.mediaType };
  }
}
