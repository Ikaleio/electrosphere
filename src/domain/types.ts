export type Backend = 'docker' | 'firecracker';
export type SandboxKind = 'instant' | 'durable';
export type InstanceState =
  | 'PROVISIONING'
  | 'READY'
  | 'RUNNING'
  | 'COMMITTING'
  | 'TERMINATING'
  | 'TERMINATED'
  | 'FAILED'
  | 'LOST';
export type ExecutionState = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'TIMED_OUT' | 'CANCELED' | 'LOST';
export type Digest = `sha256:${string}`;
export type NetworkProfile = 'none' | 'egress';

export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const EMPTY_CONTRACT_DIGEST = 'sha256:51f89ad00a9aa7d89091a52d3b49a5da84067536a9532cd883115d19d15ecbf6' as Digest;

export interface ResourceProfile {
  memoryMiB: number;
  vcpus: number;
  diskMiB: number;
  pidsMax: number;
  timeoutMs: number;
}

export const DEFAULT_RESOURCE_PROFILE: ResourceProfile = {
  memoryMiB: 512,
  vcpus: 1,
  diskMiB: 1024,
  pidsMax: 128,
  timeoutMs: 0,
};

export interface WorkspaceView {
  workspaceId: string;
  name?: string;
  ref: string;
  headCommit: Digest;
}

export interface InstanceView {
  instantId: string;
  kind: SandboxKind;
  backend: Backend;
  nodeId: 'local';
  state: InstanceState;
  baseCommit: Digest;
  workspaceId?: string;
  network: NetworkProfile;
  resourceProfile: ResourceProfile;
}

export interface ShellResult {
  status: 'running' | 'completed' | 'failed' | 'timed_out' | 'canceled' | 'killed';
  session_id?: string;
  exit_code?: number;
  output: string;
  wall_time_ms: number;
  original_token_count: number;
  output_omitted_bytes: number;
  truncated: boolean;
  chunk_id: string;
}

export function isDigest(value: string): value is Digest {
  return DIGEST_PATTERN.test(value);
}
