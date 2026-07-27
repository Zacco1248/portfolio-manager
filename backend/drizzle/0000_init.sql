CREATE TABLE `alert_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`alert_id` integer,
	`kind` text NOT NULL,
	`triggered_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`message` text NOT NULL,
	`payload` text,
	`delivered` integer DEFAULT false NOT NULL,
	`delivery_error` text,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `alert_events_triggered_idx` ON `alert_events` (`triggered_at`);--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`portfolio_id` integer,
	`instrument_id` integer,
	`condition` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`cooldown_minutes` integer DEFAULT 720 NOT NULL,
	`last_triggered_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `alerts_kind_idx` ON `alerts` (`kind`,`enabled`);--> statement-breakpoint
CREATE TABLE `benchmark_series` (
	`symbol` text NOT NULL,
	`date` text NOT NULL,
	`close_e8` integer NOT NULL,
	`currency` text DEFAULT 'PLN' NOT NULL,
	`source` text NOT NULL,
	PRIMARY KEY(`symbol`, `date`)
);
--> statement-breakpoint
CREATE TABLE `bond_holdings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`portfolio_id` integer NOT NULL,
	`instrument_id` integer,
	`series` text NOT NULL,
	`kind` text NOT NULL,
	`purchase_date` text NOT NULL,
	`count` integer NOT NULL,
	`nominal_minor` integer DEFAULT 10000 NOT NULL,
	`first_year_rate_bp` integer NOT NULL,
	`margin_bp` integer DEFAULT 0 NOT NULL,
	`term_months` integer NOT NULL,
	`maturity_date` text NOT NULL,
	`capitalization` text DEFAULT 'annual' NOT NULL,
	`early_redemption_fee_minor` integer DEFAULT 0 NOT NULL,
	`redeemed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `bond_holdings_portfolio_idx` ON `bond_holdings` (`portfolio_id`);--> statement-breakpoint
CREATE TABLE `cpi_rates` (
	`year` integer NOT NULL,
	`month` integer NOT NULL,
	`cpi_yoy_bp` integer NOT NULL,
	`source` text DEFAULT 'GUS' NOT NULL,
	PRIMARY KEY(`year`, `month`)
);
--> statement-breakpoint
CREATE TABLE `fx_rates` (
	`currency` text NOT NULL,
	`date` text NOT NULL,
	`rate_e6` integer NOT NULL,
	`table_name` text DEFAULT 'A' NOT NULL,
	`source` text DEFAULT 'NBP' NOT NULL,
	`fetched_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`currency`, `date`)
);
--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`parser_id` text NOT NULL,
	`filename` text NOT NULL,
	`file_hash` text NOT NULL,
	`portfolio_id` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`mapping` text,
	`rows` text,
	`stats` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`committed_at` text,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `import_batches_file_hash_idx` ON `import_batches` (`file_hash`);--> statement-breakpoint
CREATE TABLE `instrument_aliases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`instrument_id` integer NOT NULL,
	`source` text NOT NULL,
	`symbol` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `instrument_aliases_uq` ON `instrument_aliases` (`source`,`symbol`);--> statement-breakpoint
CREATE INDEX `instrument_aliases_instrument_idx` ON `instrument_aliases` (`instrument_id`);--> statement-breakpoint
CREATE TABLE `instruments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`name` text NOT NULL,
	`asset_class` text NOT NULL,
	`currency` text NOT NULL,
	`isin` text,
	`exchange` text,
	`sector` text,
	`country` text,
	`provider` text,
	`provider_symbol` text,
	`unit` text,
	`holdings` text,
	`meta` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `instruments_symbol_uq` ON `instruments` (`symbol`);--> statement-breakpoint
CREATE INDEX `instruments_asset_class_idx` ON `instruments` (`asset_class`);--> statement-breakpoint
CREATE INDEX `instruments_isin_idx` ON `instruments` (`isin`);--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job` text NOT NULL,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`finished_at` text,
	`status` text DEFAULT 'ok' NOT NULL,
	`message` text
);
--> statement-breakpoint
CREATE INDEX `job_runs_job_idx` ON `job_runs` (`job`,`started_at`);--> statement-breakpoint
CREATE TABLE `news_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`instrument_id` integer,
	`source` text NOT NULL,
	`url` text NOT NULL,
	`url_hash` text NOT NULL,
	`title` text NOT NULL,
	`published_at` text NOT NULL,
	`raw_summary` text,
	`ai_summary_pl` text,
	`sentiment` text,
	`importance` text,
	`ai_signal` text,
	`ai_model` text,
	`ai_analyzed_at` text,
	`fetched_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `news_items_url_hash_uq` ON `news_items` (`url_hash`);--> statement-breakpoint
CREATE INDEX `news_items_instrument_idx` ON `news_items` (`instrument_id`,`published_at`);--> statement-breakpoint
CREATE INDEX `news_items_published_idx` ON `news_items` (`published_at`);--> statement-breakpoint
CREATE TABLE `portfolio_snapshots` (
	`portfolio_id` integer NOT NULL,
	`date` text NOT NULL,
	`value_pln_minor` integer NOT NULL,
	`cash_pln_minor` integer DEFAULT 0 NOT NULL,
	`invested_pln_minor` integer DEFAULT 0 NOT NULL,
	`realized_pln_minor` integer DEFAULT 0 NOT NULL,
	`unrealized_pln_minor` integer DEFAULT 0 NOT NULL,
	`by_asset_class` text,
	`imported` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`portfolio_id`, `date`),
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `portfolio_snapshots_date_idx` ON `portfolio_snapshots` (`date`);--> statement-breakpoint
CREATE TABLE `portfolios` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text,
	`tax_regime` text DEFAULT 'taxable' NOT NULL,
	`base_currency` text DEFAULT 'PLN' NOT NULL,
	`broker` text,
	`note` text,
	`archived` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `portfolios_name_uq` ON `portfolios` (`name`);--> statement-breakpoint
CREATE TABLE `prices_daily` (
	`instrument_id` integer NOT NULL,
	`date` text NOT NULL,
	`open_e8` integer,
	`high_e8` integer,
	`low_e8` integer,
	`close_e8` integer NOT NULL,
	`volume` integer,
	`source` text NOT NULL,
	`fetched_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`instrument_id`, `date`),
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `prices_daily_date_idx` ON `prices_daily` (`date`);--> statement-breakpoint
CREATE TABLE `provider_health` (
	`id` text PRIMARY KEY NOT NULL,
	`last_success_at` text,
	`last_error_at` text,
	`last_error` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`disabled_until` text
);
--> statement-breakpoint
CREATE TABLE `quotes` (
	`instrument_id` integer PRIMARY KEY NOT NULL,
	`price_e8` integer NOT NULL,
	`currency` text NOT NULL,
	`prev_close_e8` integer,
	`ts` text NOT NULL,
	`source` text NOT NULL,
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `realized_gains` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sell_transaction_id` integer NOT NULL,
	`buy_transaction_id` integer NOT NULL,
	`portfolio_id` integer NOT NULL,
	`instrument_id` integer NOT NULL,
	`tax_category` text NOT NULL,
	`tax_exempt` integer DEFAULT false NOT NULL,
	`sale_date` text NOT NULL,
	`purchase_date` text NOT NULL,
	`qty_e8` integer NOT NULL,
	`cost_pln_minor` integer NOT NULL,
	`proceeds_pln_minor` integer NOT NULL,
	`gain_pln_minor` integer NOT NULL,
	`year` integer NOT NULL,
	FOREIGN KEY (`sell_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`buy_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `realized_gains_year_idx` ON `realized_gains` (`year`,`tax_category`);--> statement-breakpoint
CREATE INDEX `realized_gains_portfolio_idx` ON `realized_gains` (`portfolio_id`);--> statement-breakpoint
CREATE INDEX `realized_gains_sell_idx` ON `realized_gains` (`sell_transaction_id`);--> statement-breakpoint
CREATE TABLE `report_dates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`instrument_id` integer NOT NULL,
	`date` text NOT NULL,
	`label` text NOT NULL,
	`source` text,
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_dates_uq` ON `report_dates` (`instrument_id`,`date`,`label`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`expires_at` text NOT NULL,
	`user_agent` text,
	`ip` text
);
--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `target_allocations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`portfolio_id` integer,
	`dimension` text NOT NULL,
	`key` text NOT NULL,
	`target_bp` integer NOT NULL,
	`tolerance_bp` integer DEFAULT 500 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `target_allocations_uq` ON `target_allocations` (`portfolio_id`,`dimension`,`key`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`portfolio_id` integer NOT NULL,
	`instrument_id` integer,
	`type` text NOT NULL,
	`trade_date` text NOT NULL,
	`settlement_date` text,
	`qty_e8` integer DEFAULT 0 NOT NULL,
	`price_e8` integer DEFAULT 0 NOT NULL,
	`gross_minor` integer DEFAULT 0 NOT NULL,
	`fee_minor` integer DEFAULT 0 NOT NULL,
	`tax_minor` integer DEFAULT 0 NOT NULL,
	`currency` text NOT NULL,
	`fx_rate_e6` integer DEFAULT 1000000 NOT NULL,
	`fx_date` text,
	`amount_pln_minor` integer DEFAULT 0 NOT NULL,
	`note` text,
	`import_batch_id` integer,
	`row_hash` text,
	`dedupe_key` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_row_hash_uq` ON `transactions` (`row_hash`);--> statement-breakpoint
CREATE INDEX `transactions_portfolio_date_idx` ON `transactions` (`portfolio_id`,`trade_date`);--> statement-breakpoint
CREATE INDEX `transactions_instrument_idx` ON `transactions` (`instrument_id`,`trade_date`);--> statement-breakpoint
CREATE INDEX `transactions_type_idx` ON `transactions` (`type`);--> statement-breakpoint
CREATE INDEX `transactions_dedupe_idx` ON `transactions` (`dedupe_key`);--> statement-breakpoint
CREATE TABLE `watchlist` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`instrument_id` integer NOT NULL,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watchlist_instrument_uq` ON `watchlist` (`instrument_id`);