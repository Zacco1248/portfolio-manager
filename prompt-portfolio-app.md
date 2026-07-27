# Prompt do Claude Code — aplikacja "Portfolio Manager"

Skopiuj poniższą treść jako pierwszy prompt w Claude Code (uruchomionym w pustym katalogu projektu).

---

Zbuduj samohostowaną aplikację webową do zarządzania i analizy osobistego portfela inwestycyjnego. Aplikacja będzie działać na serwerze Ubuntu w sieci lokalnej, wystawiona na porcie (domyślnie 8080). Projekt od początku prowadź jako repozytorium git — zainicjuj repo, twórz sensowne commity po każdym etapie, przygotuj wszystko do wypchnięcia na GitHub (dodaj .gitignore, README.md z instrukcją instalacji i architekturą).

## Stack i infrastruktura

- Frontend: React + Vite + TypeScript + Tailwind CSS, wykresy w Recharts.
- Backend: Node.js + Express + TypeScript, baza SQLite (przez better-sqlite3 lub Drizzle ORM) z migracjami.
- Całość w Docker Compose (jeden serwis app lub app+frontend), tak żeby na Ubuntu wystarczyło `docker compose up -d`. Dane (plik SQLite, konfiguracja) w wolumenie, żeby łatwo przenosić serwer.
- Harmonogram zadań w tle: node-cron (aktualizacja cen, skan newsów, kontrola alertów).
- Konfiguracja przez plik `.env` (dodaj `.env.example` z opisem wszystkich zmiennych). Klucze API są opcjonalne — aplikacja musi działać w trybie okrojonym bez nich.
- Proste zabezpieczenie: logowanie jednym hasłem ustawianym w `.env` (sesja/cookie), bo aplikacja wisi w LAN.

## Klasy aktywów

Obsłuż: akcje (GPW i zagraniczne), ETF-y, obligacje skarbowe detaliczne (EDO/COI/TOS — z naliczaniem odsetek wg oprocentowania i indeksacji inflacją), metale fizyczne (złoto, srebro — pozycje w sztukach/uncjach/gramach z wyceną wg cen spot), kryptowaluty, gotówka/lokaty w różnych walutach. Waluta bazowa portfela: PLN, przeliczenia po kursach NBP.

## Dane i transakcje

- Ręczne wprowadzanie transakcji: kupno, sprzedaż, dywidenda, odsetki, opłata, wpłata/wypłata gotówki. Przy wpisywaniu tickera — autouzupełnianie nazwy i danych instrumentu z API.
- Metoda kosztowa FIFO do liczenia zysków zrealizowanych (zgodnie z polskim rozliczeniem podatkowym).
- Import z plików:
  - XTB — parser wyciągu/historii transakcji eksportowanej z platformy (xlsx/csv); zmapuj kolumny XTB na wewnętrzny model transakcji, obsłuż deduplikację przy ponownym imporcie.
  - Kryptowaluty wprowadzam ręcznie (bez importu z giełd) — ale architektura parserów importu ma być wtyczkowa, żeby w przyszłości dało się łatwo dodać parser CSV z giełdy krypto.
  - Arkusz Inwestomatu (https://inwestomat.eu/wlasny-arkusz-do-monitorowania-inwestycji/) — import xlsx z pozycjami; jeśli struktura arkusza okaże się zbyt zmienna, zrób elastyczny kreator mapowania kolumn przy imporcie. Zainspiruj się tym arkuszem przy projektowaniu widoków (podział na klasy aktywów, wkład własny vs zysk, historia wartości portfela w czasie).
- Możliwość prowadzenia kilku portfeli (np. główny i IKE) z widokiem zbiorczym.

## Źródła cen (darmowe, bez klucza jeśli się da)

- GPW i część zagranicy: Stooq (CSV endpoint).
- Akcje/ETF zagraniczne: Yahoo Finance (nieoficjalne API) z fallbackiem.
- Krypto: CoinGecko.
- Metale: ceny spot złota/srebra (np. Stooq XAUUSD/XAGUSD) + kurs NBP; dla złota dodatkowo cena NBP.
- Kursy walut: API NBP.
- Cache'uj ceny w bazie (historia dzienna), aktualizuj cronem co konfigurowalne N minut w godzinach sesji. Zapisuj dzienny snapshot wartości portfela do wykresu historycznego.

## Dashboard i analizy

- Strona główna: wartość portfela, zmiana dzienna/tygodniowa/całkowita, zysk vs wpłacony kapitał, wykres wartości w czasie, alokacja (donut) wg klas aktywów, walut, sektorów, geografii.
- Widok pozycji: tabela z ceną nabycia, aktualną, zyskiem %, udziałem w portfelu, sortowanie/filtrowanie.
- Stopy zwrotu: XIRR całego portfela i per pozycja, porównanie z benchmarkami (WIG, S&P 500 — konfigurowalne).
- Analiza techniczna per instrument: SMA 50/200, EMA, RSI, MACD, wykres świecowy; sygnały (np. złoty krzyż, RSI wykupienie/wyprzedanie) prezentowane jako lista z datą.
- Dywidendy: kalendarz, historia, yield portfela.

## Rebalans i kontrola koncentracji

- Użytkownik definiuje docelową alokację (per klasa aktywów, opcjonalnie per pozycja) i tolerancję odchylenia (np. ±5 p.p.).
- Aplikacja regularnie porównuje stan z celem i proponuje konkretny rebalans: co dokupić/sprzedać i za ile. Dwa tryby przełączane w ustawieniach i w widoku propozycji: (a) pełny rebalans (kupno i sprzedaż), (b) tylko dokupowanie — bez sprzedaży, rozłożone pod comiesięczne wpłaty. Pokazuj oba warianty obok siebie, jeśli to możliwe.
- Ostrzeżenia o koncentracji: pojedyncza spółka > X% portfela, sektor > Y%, nakładająca się ekspozycja ETF-ów (np. dwa ETF-y z dużym pokryciem tych samych spółek) — z propozycją uproszczenia lub dywersyfikacji.
- Planer dopłat: podaję kwotę miesięcznej wpłaty, aplikacja proponuje podział minimalizujący odchylenie od celu.

## Monitoring newsów i AI

- Lista obserwowanych: automatycznie spółki z portfela + ręcznie dodawane watchlist.
- Cron pobiera newsy per spółka z RSS/źródeł publicznych (np. Stooq/Bankier/Strefa Inwestorów dla GPW, Yahoo Finance news dla zagranicy) oraz daty publikacji raportów okresowych.
- Jeśli w `.env` jest ANTHROPIC_API_KEY: użyj Anthropic API (model claude-haiku, tanio) do: streszczenia newsów po polsku (2–3 zdania), oceny sentymentu (pozytywny/neutralny/negatywny), oznaczenia wagi (istotne/szum) i krótkiego sygnału informacyjnego "argumenty za trzymaniem / za redukcją" z uzasadnieniem. Każdy taki sygnał oznaczaj wyraźnie jako materiał informacyjny, nie doradztwo inwestycyjne. Bez klucza — pokazuj surowe nagłówki z linkami.
- Widok "Aktualności": feed per spółka + zbiorczy, filtrowanie po wadze i sentymencie.

## Powiadomienia Telegram

- Integracja z botem Telegram (token + chat_id w `.env`).
- Konfigurowalne powiadomienia: istotny news o spółce z portfela, przekroczenie progu odchylenia alokacji, alert cenowy (cena instrumentu przekroczy zadany poziom), sygnał techniczny, spadek/wzrost pozycji o > X% w dzień, przypomnienie o zbliżającym się raporcie okresowym.
- Panel w aplikacji do włączania/wyłączania typów powiadomień i testu połączenia.

## Dodatkowe

- Raport podatkowy: zestawienie zrealizowanych zysków/strat i dywidend per rok pod PIT-38 (osobno krypto, osobno papiery wartościowe, dywidendy z podatkiem u źródła), eksport CSV.
- Eksport/backup: pełny eksport danych do JSON/CSV + prosty skrypt backupu bazy.
- Tryb ciemny i jasny.

## Design

Prosty, funkcjonalny, gęsty informacyjnie dashboard finansowy — bez zbędnych ozdobników. Ciemny motyw domyślnie, akcenty kolorystyczne tylko dla zysk/strata (zieleń/czerwień) i alertów. Czytelne tabele, karty KPI u góry, spójna siatka. Responsywnie. Do zaprojektowania użyj stiitch mcp (powinien być na kompie dostępny) lub claude design


## Sposób pracy

1. Zacznij od planu architektury i schematu bazy — pokaż mi go do akceptacji przed kodowaniem.
2. Buduj etapami z commitami: (1) szkielet + baza + auth, (2) transakcje ręczne + pozycje + ceny, (3) dashboard + wykresy, (4) importy, (5) rebalans + alerty, (6) newsy + AI, (7) Telegram, (8) raport podatkowy + dopracowanie.
3. Po każdym etapie krótko opisz co działa i jak przetestować.
4. Testy jednostkowe przynajmniej dla: FIFO, XIRR, parserów importu, logiki rebalansu.

---

## Notatki (poza promptem)

- Dostęp spoza domu: zainstaluj Tailscale na serwerze Ubuntu i telefonie — aplikacja nie wymaga żadnych zmian, wchodzisz przez adres tailnetowy serwera na ten sam port. Nie wystawiaj portu publicznie.
- Do wypchnięcia na GitHub: utwórz puste repo i podaj Claude Code adres, albo użyj `gh repo create` jeśli masz zainstalowane GitHub CLI z autoryzacją.
- Klucz Anthropic API do sekcji newsów wygenerujesz na console.anthropic.com — ustaw limit wydatków, Haiku przy takim użyciu to grosze.
