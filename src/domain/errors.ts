export type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'AUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INSTANCE_BUSY'
  | 'HEAD_CONFLICT'
  | 'THREAD_BUSY'
  | 'TURN_CLOSED'
  | 'SNAPSHOT_LIMIT'
  | 'SNAPSHOT_UNSUPPORTED_ENTRY'
  | 'BACKEND_ERROR'
  | 'BACKEND_UNAVAILABLE'
  | 'EXECUTION_TIMED_OUT'
  | 'STORAGE_EXHAUSTED'
  | 'SESSION_CAPACITY'
  | 'SESSION_STDIN_CLOSED';

const statusByCode: Record<ErrorCode, number> = {
  INVALID_ARGUMENT: 400,
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INSTANCE_BUSY: 409,
  HEAD_CONFLICT: 409,
  THREAD_BUSY: 409,
  TURN_CLOSED: 409,
  SNAPSHOT_LIMIT: 413,
  SNAPSHOT_UNSUPPORTED_ENTRY: 422,
  BACKEND_ERROR: 500,
  BACKEND_UNAVAILABLE: 500,
  EXECUTION_TIMED_OUT: 504,
  STORAGE_EXHAUSTED: 507,
  SESSION_CAPACITY: 409,
  SESSION_STDIN_CLOSED: 409,
};

export class ServiceError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ServiceError';
    this.status = statusByCode[code];
  }
}
