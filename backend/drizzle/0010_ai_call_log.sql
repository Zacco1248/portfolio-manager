CREATE TABLE `ai_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`feature` text NOT NULL,
	`origin` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`error_kind` text,
	`error_message` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`cost_micro_usd` integer,
	`duration_ms` integer
);
--> statement-breakpoint
CREATE INDEX `ai_calls_created_idx` ON `ai_calls` (`created_at`);--> statement-breakpoint
CREATE INDEX `ai_calls_feature_idx` ON `ai_calls` (`feature`,`created_at`);--> statement-breakpoint
ALTER TABLE `news_items` ADD `ai_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `news_items` ADD `ai_error` text;