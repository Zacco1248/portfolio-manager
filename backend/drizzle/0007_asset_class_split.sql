-- ── Rozbicie akcji i ETF-ów na krajowe i zagraniczne ────────────────────────
--
-- Heurystyka jest wiernym portem `isDomesticInstrument` z shared/src/domain.ts.
-- Kolejność warunków musi zostać taka sama: giełda, potem symbol, na końcu
-- waluta przy braku giełdy.
UPDATE instruments SET asset_class = CASE
  WHEN upper(coalesce(exchange, '')) IN ('WSE','GPW','WAR','WA') THEN 'stock_pl'
  WHEN upper(symbol) LIKE 'WSE:%'                                THEN 'stock_pl'
  WHEN upper(symbol) LIKE '%.WA'                                 THEN 'stock_pl'
  WHEN exchange IS NULL AND currency = 'PLN'                     THEN 'stock_pl'
  ELSE 'stock_foreign'
END
WHERE asset_class = 'stock';
--> statement-breakpoint
UPDATE instruments SET asset_class = CASE
  WHEN upper(coalesce(exchange, '')) IN ('WSE','GPW','WAR','WA') THEN 'etf_pl'
  WHEN upper(symbol) LIKE 'WSE:%'                                THEN 'etf_pl'
  WHEN upper(symbol) LIKE '%.WA'                                 THEN 'etf_pl'
  WHEN exchange IS NULL AND currency = 'PLN'                     THEN 'etf_pl'
  ELSE 'etf_foreign'
END
WHERE asset_class = 'etf';
--> statement-breakpoint

-- ── Cele alokacji ───────────────────────────────────────────────────────────
--
-- Wymiar `equity_split` przestał istnieć: `asset_class` zwraca teraz dokładnie
-- te klucze, które on produkował. Przy kolizji wygrywa `equity_split` — był
-- bardziej szczegółowy, więc został ustawiony świadomiej.
--
-- Celów z kluczem 'stock' i 'etf' NIE ruszamy. Zostają jako cele na poziomie
-- grupy i dalej działają: `valueForKey` sumuje pod nie oba liście. To jest
-- realizacja wymogu, żeby akcje polskie i zagraniczne sumowały się do „akcji".
DELETE FROM target_allocations
WHERE dimension = 'asset_class'
  AND EXISTS (
    SELECT 1 FROM target_allocations t2
    WHERE t2.dimension = 'equity_split'
      AND t2.key = target_allocations.key
      AND t2.portfolio_id IS target_allocations.portfolio_id
  );
--> statement-breakpoint
UPDATE target_allocations SET dimension = 'asset_class' WHERE dimension = 'equity_split';
