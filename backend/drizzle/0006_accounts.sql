CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'broker' NOT NULL,
	`institution` text,
	`currency` text DEFAULT 'PLN' NOT NULL,
	`note` text,
	`archived` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_name_uq` ON `accounts` (`name`);--> statement-breakpoint
ALTER TABLE `bond_holdings` ADD `account_id` integer REFERENCES accounts(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `transactions` ADD `account_id` integer REFERENCES accounts(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `transactions_account_idx` ON `transactions` (`account_id`,`trade_date`);--> statement-breakpoint

-- ── Backfill kont dla danych sprzed tej migracji ─────────────────────────────
-- Źródło nazwy konta, w kolejności zaufania:
--   1. portfolios.broker — pole ma dokładnie to znaczenie, tylko nigdy nie było
--      używane do grupowania,
--   2. portfolios.name — gdy broker pusty. Odtwarza stan faktyczny sprzed tej
--      zmiany, w którym portfel BYŁ kontem. Nic nie zgadujemy ponad to.
INSERT INTO accounts (name, kind, sort_order)
SELECT DISTINCT TRIM(p.broker), 'broker', 0
FROM portfolios p
WHERE p.broker IS NOT NULL AND TRIM(p.broker) <> ''
  AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.name = TRIM(p.broker));
--> statement-breakpoint
INSERT INTO accounts (name, kind, sort_order)
SELECT p.name, 'other', p.sort_order
FROM portfolios p
WHERE (p.broker IS NULL OR TRIM(p.broker) = '')
  AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.name = p.name);
--> statement-breakpoint
UPDATE transactions SET account_id = (
  SELECT a.id FROM accounts a
  JOIN portfolios p ON p.id = transactions.portfolio_id
  WHERE a.name = COALESCE(NULLIF(TRIM(p.broker), ''), p.name)
) WHERE account_id IS NULL;
--> statement-breakpoint
UPDATE bond_holdings SET account_id = (
  SELECT a.id FROM accounts a
  JOIN portfolios p ON p.id = bond_holdings.portfolio_id
  WHERE a.name = COALESCE(NULLIF(TRIM(p.broker), ''), p.name)
) WHERE account_id IS NULL;
