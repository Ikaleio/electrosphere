import { timingSafeEqual } from 'node:crypto';
import { createMcpHonoApp as createOfficialMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import type { Context, Hono } from 'hono';
import { z, type ZodType } from 'zod/v4';
import type { BackendRegistry, HostProbe } from '../backends/types.ts';
import { ServiceError } from '../domain/errors.ts';
import type { SandboxService } from '../domain/sandbox-service.ts';
import type { SessionManager } from '../domain/session-manager.ts';
import { TURN_IDENTIFIER_PATTERN, type TurnLease, type TurnService } from '../domain/turn-service.ts';
import { DIGEST_PATTERN, type Backend, type Digest } from '../domain/types.ts';
import { buildMcpServer } from '../mcp/server.ts';
import type { ArtifactStore } from '../storage/artifacts.ts';

const resourceProfile = z.object({
  memoryMiB: z.number().int().min(64).max(8192),
  vcpus: z.number().int().min(1).max(8),
  diskMiB: z.number().int().min(64).max(16_384),
  pidsMax: z.number().int().min(16).max(1024),
  timeoutMs: z.number().int().min(0).max(86_400_000),
}).strict();
const startTurnSchema = z.object({
  mode: z.enum(['instant', 'durable']),
  backend: z.enum(['docker', 'firecracker']).optional(),
  network: z.enum(['none', 'egress']).optional(),
  resourceProfile: resourceProfile.optional(),
}).strict();
const harnessForkSchema = z.object({ commitId: z.string().regex(DIGEST_PATTERN).optional() }).strict();
const INTERNAL_LEASE_HEADER = 'Electrosphere-Internal-Lease-Id';

interface McpEnvelope {
  method?: string;
  id: string | number | null;
  body?: Uint8Array;
}

async function body<T>(context: Context, schema: ZodType<T>): Promise<T> {
  let value: unknown;
  try {
    value = await context.req.json();
  } catch {
    throw new ServiceError('INVALID_ARGUMENT', 'Request body must be valid JSON');
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ServiceError('INVALID_ARGUMENT', 'Request validation failed', parsed.error.flatten());
  return parsed.data;
}

async function noBody(context: Context): Promise<void> {
  if ((await context.req.text()).length > 0) throw new ServiceError('INVALID_ARGUMENT', 'Request body must be empty');
}

function decodedIdentifier(name: string, value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ServiceError('INVALID_ARGUMENT', `${name} is not valid URL encoding`);
  }
  if (!TURN_IDENTIFIER_PATTERN.test(decoded)) throw new ServiceError('INVALID_ARGUMENT', `${name} is invalid`);
  return decoded;
}

function requireAuth(request: Request, expectedToken?: string): void {
  if (!expectedToken) throw new ServiceError('AUTH_REQUIRED', 'Harness authentication is not configured');
  const authorization = request.headers.get('authorization');
  if (!authorization || authorization.length > 8192 || !authorization.startsWith('Bearer ')) {
    throw new ServiceError('AUTH_REQUIRED', 'Bearer authentication is required');
  }
  const providedToken = authorization.slice('Bearer '.length);
  if (providedToken.length === 0) throw new ServiceError('AUTH_REQUIRED', 'Bearer authentication is required');
  const expectedLength = Buffer.byteLength(expectedToken);
  const providedLength = Buffer.byteLength(providedToken);
  if (expectedLength !== providedLength) throw new ServiceError('FORBIDDEN', 'Bearer token is invalid');
  if (!timingSafeEqual(Buffer.from(expectedToken), Buffer.from(providedToken))) {
    throw new ServiceError('FORBIDDEN', 'Bearer token is invalid');
  }
}

async function inspectMcpRequest(request: Request): Promise<McpEnvelope> {
  const body = request.method === 'GET' || request.method === 'HEAD'
    ? undefined
    : new Uint8Array(await request.arrayBuffer());
  let value: unknown;
  try {
    value = body && body.byteLength > 0 ? JSON.parse(Buffer.from(body).toString('utf8')) : undefined;
  } catch {
    const headerMethod = request.headers.get('Mcp-Method');
    return { ...(headerMethod ? { method: headerMethod } : {}), id: null, ...(body ? { body } : {}) };
  }
  const messages = Array.isArray(value) ? value : [value];
  const objects = messages.filter((message): message is Record<string, unknown> => typeof message === 'object' && message !== null);
  const bodyMethod = objects.find((message) => message.method === 'tools/call')?.method
    ?? objects.find((message) => typeof message.method === 'string')?.method;
  const bodyId = objects.length === 1 && (typeof objects[0]!.id === 'string' || typeof objects[0]!.id === 'number')
    ? objects[0]!.id
    : null;
  const method = request.headers.get('Mcp-Method') ?? (typeof bodyMethod === 'string' ? bodyMethod : undefined);
  return { ...(method ? { method } : {}), id: bodyId, ...(body ? { body } : {}) };
}

function jsonRpcTurnError(context: Context, id: string | number | null, error: ServiceError): Response {
  return context.json({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32602,
      message: error.message,
      data: { code: error.code, ...(error.details === undefined ? {} : { details: error.details }) },
    },
  }, 400);
}

function errorResponse(context: Context, error: unknown): Response {
  if (error instanceof ServiceError) {
    return context.json({ error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } }, error.status as 400);
  }
  const message = error instanceof Error ? error.message : String(error);
  return context.json({ error: { code: 'BACKEND_ERROR', message } }, 500);
}

export interface DaemonApp {
  app: Hono;
  handler: McpHttpHandler;
}

export function createMcpHonoApp(input: {
  host: string;
  service: SandboxService;
  sessions: SessionManager;
  turns: TurnService;
  artifactStore: ArtifactStore;
  authToken?: string;
  backends: BackendRegistry;
  storageReady: boolean;
  probes: Record<Backend, HostProbe>;
}): DaemonApp {
  const app = createOfficialMcpHonoApp({ host: input.host });
  const handler = createMcpHandler(({ requestInfo }) => {
    const leaseId = requestInfo?.headers.get(INTERNAL_LEASE_HEADER);
    const turn = leaseId ? input.turns.resolveLease(leaseId) : undefined;
    return buildMcpServer({
      service: input.service,
      sessions: input.sessions,
      artifactStore: input.artifactStore,
      ...(turn ? { turn } : {}),
    });
  }, {
    legacy: 'stateless',
    responseMode: 'auto',
  });

  app.get('/healthz', (context) => context.json({
    status: input.storageReady && input.probes.docker.available ? 'ok' : 'degraded',
    nodeId: 'local',
    sqlite: { ready: input.storageReady },
    backends: input.probes,
  }, 200));

  app.post('/v1/harness/threads/:threadId/turns/:turnId', async (context) => {
    try {
      requireAuth(context.req.raw, input.authToken);
      const threadId = decodedIdentifier('threadId', context.req.param('threadId'));
      const turnId = decodedIdentifier('turnId', context.req.param('turnId'));
      const request = await body(context, startTurnSchema);
      return context.json(await input.turns.start({
        threadId,
        turnId,
        mode: request.mode,
        ...(request.backend ? { backend: request.backend } : {}),
        ...(request.network ? { network: request.network } : {}),
        ...(request.resourceProfile ? { resourceProfile: request.resourceProfile } : {}),
      }), 201);
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.post('/v1/harness/threads/:threadId/turns/:turnId/finish', async (context) => {
    try {
      requireAuth(context.req.raw, input.authToken);
      const threadId = decodedIdentifier('threadId', context.req.param('threadId'));
      const turnId = decodedIdentifier('turnId', context.req.param('turnId'));
      await noBody(context);
      return context.json(await input.turns.finish({ threadId, turnId }));
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.post('/v1/harness/threads/:sourceThreadId/forks/:destinationThreadId', async (context) => {
    try {
      requireAuth(context.req.raw, input.authToken);
      const sourceThreadId = decodedIdentifier('sourceThreadId', context.req.param('sourceThreadId'));
      const destinationThreadId = decodedIdentifier('destinationThreadId', context.req.param('destinationThreadId'));
      const request = await body(context, harnessForkSchema);
      return context.json(await input.turns.fork({
        sourceThreadId,
        destinationThreadId,
        ...(request.commitId ? { commitId: request.commitId as Digest } : {}),
      }), 201);
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.all('/mcp', async (context) => {
    const envelope = await inspectMcpRequest(context.req.raw);
    try {
      requireAuth(context.req.raw, input.authToken);
    } catch (error) {
      return errorResponse(context, error);
    }
    const headers = new Headers(context.req.raw.headers);
    headers.delete(INTERNAL_LEASE_HEADER);
    let lease: TurnLease | undefined;
    if (envelope.method === 'tools/call') {
      try {
        const threadId = context.req.header('Electrosphere-Thread-Id');
        const turnId = context.req.header('Electrosphere-Turn-Id');
        if (!threadId || !turnId) throw new ServiceError('INVALID_ARGUMENT', 'Electrosphere thread and turn headers are required');
        if (!TURN_IDENTIFIER_PATTERN.test(threadId) || !TURN_IDENTIFIER_PATTERN.test(turnId)) {
          throw new ServiceError('INVALID_ARGUMENT', 'Electrosphere thread or turn header is invalid');
        }
        lease = input.turns.acquire(threadId, turnId);
        headers.set(INTERNAL_LEASE_HEADER, lease.id);
      } catch (error) {
        const serviceError = error instanceof ServiceError ? error : new ServiceError('BACKEND_ERROR', error instanceof Error ? error.message : String(error));
        return jsonRpcTurnError(context, envelope.id, serviceError);
      }
    }
    const forwarded = new Request(context.req.url, {
      method: context.req.raw.method,
      headers,
      ...(envelope.body ? { body: Buffer.from(envelope.body).toString('utf8') } : {}),
      signal: context.req.raw.signal,
    });
    try {
      return await handler.fetch(forwarded);
    } finally {
      lease?.release();
    }
  });
  app.notFound((context) => context.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404));
  app.onError((error, context) => errorResponse(context, error));
  return { app, handler };
}
