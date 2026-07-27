CREATE TABLE `dividend_events` (
	`instrument_id` integer NOT NULL,
	`ex_date` text NOT NULL,
	`amount_e8` integer NOT NULL,
	`currency` text NOT NULL,
	`source` text NOT NULL,
	`fetched_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`instrument_id`, `ex_date`),
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `report_dates` ADD `note` text;