import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod/v4';
import type { Backend } from '../domain/types.ts';

const loopbackHosts: Record<string, true> = { '127.0.0.1': true, localhost: true, '::1': true };

export interface Config {
  dataDir: string;
  host: string;
  port: number;
  defaultBackend: Backend;
  dockerSocket: string;
  firecrackerBin?: string;
  jailerBin?: string;
  agentArtifact?: string;
  runtimeImage?: string;
  firecrackerKernel?: string;
  firecrackerRootfs?: string;
  maxOutputBytes: number;
  authToken?: string;
}

const envSchema = z.object({
  ELECTROSPHERE_DATA_DIR: z.string().min(1),
  ELECTROSPHERE_HOST: z.string().default('127.0.0.1'),
  ELECTROSPHERE_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  ELECTROSPHERE_DEFAULT_BACKEND: z.enum(['docker', 'firecracker']).default('docker'),
  ELECTROSPHERE_DOCKER_SOCKET: z.string().min(1).default('/var/run/docker.sock'),
  ELECTROSPHERE_FIRECRACKER_BIN: z.string().min(1).optional(),
  ELECTROSPHERE_JAILER_BIN: z.string().min(1).optional(),
  ELECTROSPHERE_AGENT_ARTIFACT: z.string().min(1).optional(),
  ELECTROSPHERE_RUNTIME_IMAGE: z.string().min(1).optional(),
  ELECTROSPHERE_FIRECRACKER_KERNEL: z.string().min(1).optional(),
  ELECTROSPHERE_FIRECRACKER_ROOTFS: z.string().min(1).optional(),
  ELECTROSPHERE_MAX_OUTPUT_BYTES: z.coerce.number().int().min(1024).max(16 * 1024 * 1024).default(1_048_576),
  ELECTROSPHERE_AUTH_TOKEN: z.string().min(1).optional(),
}).passthrough();

export function loadConfig(env: Record<string, string | undefined> = Bun.env): Config {
  const parsed = envSchema.parse(env);
  if (!isAbsolute(parsed.ELECTROSPHERE_DATA_DIR)) {
    throw new Error('ELECTROSPHERE_DATA_DIR must be an absolute path');
  }
  if (loopbackHosts[parsed.ELECTROSPHERE_HOST] !== true) {
    throw new Error('ELECTROSPHERE_HOST must be a loopback address');
  }
  return {
    dataDir: resolve(parsed.ELECTROSPHERE_DATA_DIR),
    host: parsed.ELECTROSPHERE_HOST,
    port: parsed.ELECTROSPHERE_PORT,
    defaultBackend: parsed.ELECTROSPHERE_DEFAULT_BACKEND,
    dockerSocket: parsed.ELECTROSPHERE_DOCKER_SOCKET,
    maxOutputBytes: parsed.ELECTROSPHERE_MAX_OUTPUT_BYTES,
    ...(parsed.ELECTROSPHERE_FIRECRACKER_BIN ? { firecrackerBin: parsed.ELECTROSPHERE_FIRECRACKER_BIN } : {}),
    ...(parsed.ELECTROSPHERE_JAILER_BIN ? { jailerBin: parsed.ELECTROSPHERE_JAILER_BIN } : {}),
    ...(parsed.ELECTROSPHERE_AGENT_ARTIFACT ? { agentArtifact: parsed.ELECTROSPHERE_AGENT_ARTIFACT } : {}),
    ...(parsed.ELECTROSPHERE_RUNTIME_IMAGE ? { runtimeImage: parsed.ELECTROSPHERE_RUNTIME_IMAGE } : {}),
    ...(parsed.ELECTROSPHERE_FIRECRACKER_KERNEL ? { firecrackerKernel: parsed.ELECTROSPHERE_FIRECRACKER_KERNEL } : {}),
    ...(parsed.ELECTROSPHERE_FIRECRACKER_ROOTFS ? { firecrackerRootfs: parsed.ELECTROSPHERE_FIRECRACKER_ROOTFS } : {}),
    ...(parsed.ELECTROSPHERE_AUTH_TOKEN ? { authToken: parsed.ELECTROSPHERE_AUTH_TOKEN } : {}),
  };
}
