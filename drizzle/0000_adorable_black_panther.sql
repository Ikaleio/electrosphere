CREATE TABLE `artifacts` (
	`digest` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`metadata_json` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `commits` (
	`id` text PRIMARY KEY NOT NULL,
	`tree_digest` text NOT NULL,
	`contract_digest` text NOT NULL,
	`parent_id` text,
	`name` text,
	`message` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `commits`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "commits_id_digest" CHECK("commits"."id" GLOB 'sha256:[0-9a-f]*' AND length("commits"."id") = 71)
);
--> statement-breakpoint
CREATE INDEX `commits_parent_idx` ON `commits` (`parent_id`);--> statement-breakpoint
CREATE TABLE `execution_chunks` (
	`execution_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`stream` text NOT NULL,
	`bytes` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`execution_id`, `sequence`),
	FOREIGN KEY (`execution_id`) REFERENCES `executions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "execution_chunks_stream_check" CHECK(stream IN ('stdout','stderr','tty'))
);
--> statement-breakpoint
CREATE TABLE `executions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text,
	`instance_id` text NOT NULL,
	`state` text NOT NULL,
	`command` text NOT NULL,
	`exit_code` integer,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`instance_id`) REFERENCES `instances`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "executions_state_check" CHECK(state IN ('RUNNING','COMPLETED','FAILED','TIMED_OUT','CANCELED','LOST'))
);
--> statement-breakpoint
CREATE INDEX `executions_instance_idx` ON `executions` (`instance_id`);--> statement-breakpoint
CREATE TABLE `instances` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'instant' NOT NULL,
	`backend` text NOT NULL,
	`node_id` text DEFAULT 'local' NOT NULL,
	`state` text NOT NULL,
	`workspace_id` text,
	`base_commit` text NOT NULL,
	`backend_handle` text,
	`workspace_path` text NOT NULL,
	`resource_profile` text NOT NULL,
	`network` text DEFAULT 'none' NOT NULL,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`base_commit`) REFERENCES `commits`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "instances_kind_check" CHECK(kind IN ('instant','durable')),
	CONSTRAINT "instances_backend_check" CHECK(backend IN ('docker','firecracker')),
	CONSTRAINT "instances_state_check" CHECK(state IN ('PROVISIONING','READY','RUNNING','COMMITTING','TERMINATING','TERMINATED','FAILED','LOST')),
	CONSTRAINT "instances_node_check" CHECK("instances"."node_id" = 'local'),
	CONSTRAINT "instances_network_check" CHECK(network IN ('none','egress'))
);
--> statement-breakpoint
CREATE INDEX `instances_state_idx` ON `instances` (`state`);--> statement-breakpoint
CREATE INDEX `instances_base_commit_idx` ON `instances` (`base_commit`);--> statement-breakpoint
CREATE TABLE `operations` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_kind` text NOT NULL,
	`client_request_id` text NOT NULL,
	`status` text NOT NULL,
	`response_json` text,
	`error_json` text,
	`lease_expires_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "operations_status_check" CHECK(status IN ('RUNNING','SUCCEEDED','FAILED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operations_idempotency_unique` ON `operations` (`operation_kind`,`client_request_id`);--> statement-breakpoint
CREATE TABLE `refs` (
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`head_commit` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`workspace_id`, `name`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`head_commit`) REFERENCES `commits`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `refs_head_idx` ON `refs` (`head_commit`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`execution_id` text NOT NULL,
	`tty` integer NOT NULL,
	`cwd` text NOT NULL,
	`state` text NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`instance_id`) REFERENCES `instances`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sessions_state_check" CHECK(state IN ('RUNNING','COMPLETED','FAILED','TIMED_OUT','CANCELED','LOST'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_execution_unique` ON `sessions` (`execution_id`);--> statement-breakpoint
CREATE INDEX `sessions_instance_idx` ON `sessions` (`instance_id`);--> statement-breakpoint
CREATE TABLE `tree_objects` (
	`digest` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
