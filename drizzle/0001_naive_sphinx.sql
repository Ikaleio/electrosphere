CREATE TABLE `artifact_grants` (
	`thread_id` text NOT NULL,
	`digest` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`thread_id`, `digest`),
	FOREIGN KEY (`digest`) REFERENCES `artifacts`(`digest`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `thread_workspaces` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_workspaces_workspace_unique` ON `thread_workspaces` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `turns` (
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`mode` text NOT NULL,
	`state` text NOT NULL,
	`instance_id` text,
	`workspace_id` text,
	`expected_head` text,
	`request_json` text NOT NULL,
	`result_json` text,
	`error_json` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	PRIMARY KEY(`thread_id`, `turn_id`),
	FOREIGN KEY (`instance_id`) REFERENCES `instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`expected_head`) REFERENCES `commits`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "turns_mode_check" CHECK(mode IN ('instant','durable')),
	CONSTRAINT "turns_state_check" CHECK(state IN ('STARTING','OPEN','FINISHING','FINISHED','FAILED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turns_open_thread_unique` ON `turns` (`thread_id`) WHERE "turns"."state" IN ('STARTING','OPEN','FINISHING');--> statement-breakpoint
CREATE INDEX `turns_instance_idx` ON `turns` (`instance_id`);--> statement-breakpoint
CREATE INDEX `turns_workspace_idx` ON `turns` (`workspace_id`);