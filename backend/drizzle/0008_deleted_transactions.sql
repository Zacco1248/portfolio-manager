CREATE TABLE `deleted_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`transaction_id` integer NOT NULL,
	`portfolio_id` integer NOT NULL,
	`instrument_id` integer,
	`account_id` integer,
	`type` text NOT NULL,
	`trade_date` text NOT NULL,
	`amount_pln_minor` integer DEFAULT 0 NOT NULL,
	`payload` text NOT NULL,
	`deleted_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `deleted_transactions_deleted_idx` ON `deleted_transactions` (`deleted_at`);