import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const now = sql`(unixepoch() * 1000)`;
const instanceStates = "'PROVISIONING','READY','RUNNING','COMMITTING','TERMINATING','TERMINATED','FAILED','LOST'";
const executionStates = "'RUNNING','COMPLETED','FAILED','TIMED_OUT','CANCELED','LOST'";
const turnStates = "'STARTING','OPEN','FINISHING','FINISHED','FAILED'";

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name'),
  createdAt: integer('created_at').notNull().default(now),
});

export const threadWorkspaces = sqliteTable('thread_workspaces', {
  threadId: text('thread_id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  createdAt: integer('created_at').notNull().default(now),
}, (table) => [
  uniqueIndex('thread_workspaces_workspace_unique').on(table.workspaceId),
]);

export const commits = sqliteTable('commits', {
  id: text('id').primaryKey(),
  treeDigest: text('tree_digest').notNull(),
  contractDigest: text('contract_digest').notNull(),
  parentId: text('parent_id'),
  name: text('name'),
  message: text('message'),
  createdAt: integer('created_at').notNull().default(now),
}, (table) => [
  foreignKey({ columns: [table.parentId], foreignColumns: [table.id] }),
  index('commits_parent_idx').on(table.parentId),
  check('commits_id_digest', sql`${table.id} GLOB 'sha256:[0-9a-f]*' AND length(${table.id}) = 71`),
]);

export const refs = sqliteTable('refs', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  headCommit: text('head_commit').notNull().references(() => commits.id),
  updatedAt: integer('updated_at').notNull().default(now),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.name] }),
  index('refs_head_idx').on(table.headCommit),
]);

export const treeObjects = sqliteTable('tree_objects', {
  digest: text('digest').primaryKey(),
  path: text('path').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  createdAt: integer('created_at').notNull().default(now),
});

export const instances = sqliteTable('instances', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull().default('instant'),
  backend: text('backend').notNull(),
  nodeId: text('node_id').notNull().default('local'),
  state: text('state').notNull(),
  workspaceId: text('workspace_id').references(() => workspaces.id),
  baseCommit: text('base_commit').notNull().references(() => commits.id),
  backendHandle: text('backend_handle'),
  workspacePath: text('workspace_path').notNull(),
  resourceProfile: text('resource_profile').notNull(),
  network: text('network').notNull().default('none'),
  lastError: text('last_error'),
  createdAt: integer('created_at').notNull().default(now),
  updatedAt: integer('updated_at').notNull().default(now),
}, (table) => [
  check('instances_kind_check', sql.raw(`${table.kind.name} IN ('instant','durable')`)),
  check('instances_backend_check', sql.raw(`${table.backend.name} IN ('docker','firecracker')`)),
  check('instances_state_check', sql.raw(`${table.state.name} IN (${instanceStates})`)),
  check('instances_node_check', sql`${table.nodeId} = 'local'`),
  check('instances_network_check', sql.raw(`${table.network.name} IN ('none','egress')`)),
  index('instances_state_idx').on(table.state),
  index('instances_base_commit_idx').on(table.baseCommit),
]);

export const turns = sqliteTable('turns', {
  threadId: text('thread_id').notNull(),
  turnId: text('turn_id').notNull(),
  mode: text('mode').notNull(),
  state: text('state').notNull(),
  instanceId: text('instance_id').references(() => instances.id),
  workspaceId: text('workspace_id').references(() => workspaces.id),
  expectedHead: text('expected_head').references(() => commits.id),
  requestJson: text('request_json').notNull(),
  resultJson: text('result_json'),
  errorJson: text('error_json'),
  createdAt: integer('created_at').notNull(),
  finishedAt: integer('finished_at'),
}, (table) => [
  primaryKey({ columns: [table.threadId, table.turnId] }),
  check('turns_mode_check', sql.raw(`${table.mode.name} IN ('instant','durable')`)),
  check('turns_state_check', sql.raw(`${table.state.name} IN (${turnStates})`)),
  uniqueIndex('turns_open_thread_unique').on(table.threadId).where(sql`${table.state} IN ('STARTING','OPEN','FINISHING')`),
  index('turns_instance_idx').on(table.instanceId),
  index('turns_workspace_idx').on(table.workspaceId),
]);

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  instanceId: text('instance_id').notNull().references(() => instances.id, { onDelete: 'cascade' }),
  executionId: text('execution_id').notNull(),
  tty: integer('tty', { mode: 'boolean' }).notNull(),
  cwd: text('cwd').notNull(),
  state: text('state').notNull(),
  expiresAt: integer('expires_at').notNull(),
  lastUsedAt: integer('last_used_at').notNull().default(now),
  createdAt: integer('created_at').notNull().default(now),
}, (table) => [
  check('sessions_state_check', sql.raw(`${table.state.name} IN (${executionStates})`)),
  uniqueIndex('sessions_execution_unique').on(table.executionId),
  index('sessions_instance_idx').on(table.instanceId),
]);

export const executions = sqliteTable('executions', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
  instanceId: text('instance_id').notNull().references(() => instances.id, { onDelete: 'cascade' }),
  state: text('state').notNull(),
  command: text('command').notNull(),
  exitCode: integer('exit_code'),
  startedAt: integer('started_at').notNull().default(now),
  finishedAt: integer('finished_at'),
}, (table) => [
  check('executions_state_check', sql.raw(`${table.state.name} IN (${executionStates})`)),
  index('executions_instance_idx').on(table.instanceId),
]);

export const executionChunks = sqliteTable('execution_chunks', {
  executionId: text('execution_id').notNull().references(() => executions.id, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull(),
  stream: text('stream').notNull(),
  bytes: text('bytes').notNull(),
  createdAt: integer('created_at').notNull().default(now),
}, (table) => [
  primaryKey({ columns: [table.executionId, table.sequence] }),
  check('execution_chunks_stream_check', sql.raw(`${table.stream.name} IN ('stdout','stderr','tty')`)),
]);

export const operations = sqliteTable('operations', {
  id: text('id').primaryKey(),
  operationKind: text('operation_kind').notNull(),
  clientRequestId: text('client_request_id').notNull(),
  status: text('status').notNull(),
  responseJson: text('response_json'),
  errorJson: text('error_json'),
  leaseExpiresAt: integer('lease_expires_at'),
  createdAt: integer('created_at').notNull().default(now),
  updatedAt: integer('updated_at').notNull().default(now),
}, (table) => [
  uniqueIndex('operations_idempotency_unique').on(table.operationKind, table.clientRequestId),
  check('operations_status_check', sql.raw(`${table.status.name} IN ('RUNNING','SUCCEEDED','FAILED')`)),
]);

export const artifacts = sqliteTable('artifacts', {
  digest: text('digest').primaryKey(),
  kind: text('kind').notNull(),
  path: text('path').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  metadataJson: text('metadata_json').notNull(),
  createdAt: integer('created_at').notNull().default(now),
});

export const artifactGrants = sqliteTable('artifact_grants', {
  threadId: text('thread_id').notNull(),
  digest: text('digest').notNull().references(() => artifacts.digest),
  createdAt: integer('created_at').notNull().default(now),
}, (table) => [
  primaryKey({ columns: [table.threadId, table.digest] }),
]);
