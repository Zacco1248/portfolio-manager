CREATE TABLE `analyst_ratings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`instrument_id` integer NOT NULL,
	`url_hash` text NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`published_at` text NOT NULL,
	`broker` text,
	`rating` text,
	`target_price_e8` integer,
	`direction` text,
	`source` text NOT NULL,
	`fetched_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analyst_ratings_url_uq` ON `analyst_ratings` (`url_hash`);--> statement-breakpoint
CREATE INDEX `analyst_ratings_instrument_idx` ON `analyst_ratings` (`instrument_id`,`published_at`);