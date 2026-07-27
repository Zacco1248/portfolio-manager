# Portfolio Manager

Samohostowana aplikacja webowa do zarządzania i analizy osobistego portfela inwestycyjnego. Obsługuje wiele portfeli o różnych reżimach podatkowych (zwykły, IKE, IKZE), akcje, ETF-y, obligacje detaliczne, metale, kryptowaluty i gotówkę. Waluta bazowa: PLN.

Aplikacja jest przeznaczona do uruchomienia na własnym serwerze w sieci lokalnej — nie wystawiaj jej do internetu.

---

## Spis treści

- [Szybki start](#szybki-start)
- [Konfiguracja](#konfiguracja)
- [Funkcje](#funkcje)
- [Architektura](#architektura)
- [Reprezentacja liczb](#reprezentacja-liczb)
- [Źródła danych](#źródła-danych)
- [Import danych](#import-danych)
- [Rozliczenie podatkowe](#rozliczenie-podatkowe)
- [Dostęp spoza domu](#dostęp-spoza-domu)
- [Kopie zapasowe](#kopie-zapasowe)
- [Rozwój lokalny](#rozwój-lokalny)
- [Ograniczenia](#ograniczenia)

---

## Szybki start

Wymagania: Docker i Docker Compose (albo Node.js 20+ do uruchomienia bez kontenera).

```bash
git clone https://github.com/Zacco1248/portfolio-manager.git
cd portfolio-manager

cp .env.example .env
# Ustaw APP_PASSWORD i wygeneruj SESSION_SECRET:
#   openssl rand -hex 32
nano .env

docker compose up -d --build
```

Aplikacja jest dostępna pod `http://<adres-serwera>:8080`. Zaloguj się hasłem z `APP_PASSWORD`.

Kontener nie wystartuje, jeśli `APP_PASSWORD` albo `SESSION_SECRET` zostały z domyślnymi wartościami — to celowe zabezpieczenie przed uruchomieniem z hasłem z przykładu.

---

## Konfiguracja

Cała konfiguracja idzie przez plik `.env`. Pełna lista zmiennych z opisami znajduje się w [`.env.example`](.env.example).

**Wymagane:**

| Zmienna | Opis |
|---|---|
| `APP_PASSWORD` | Hasło do logowania. Jedyny użytkownik. |
| `SESSION_SECRET` | Sekret sesji, min. 16 znaków. Wygeneruj: `openssl rand -hex 32`. |

**Opcjonalne — brak klucza oznacza wyłączoną funkcję, nigdy błąd:**

| Zmienna | Bez niej | Z nią |
|---|---|---|
| `ANTHROPIC_API_KEY` | Newsy jako surowe nagłówki z linkami | Streszczenia po polsku, sentyment, ocena istotności |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Alerty widoczne tylko w aplikacji | Powiadomienia push na Telegramie |

Pozostałe zmienne sterują portem, częstotliwością odświeżania cen, godzinami sesji i włączaniem poszczególnych zadań cyklicznych.

---

## Funkcje

**Portfele i transakcje**
- Wiele portfeli z osobnym reżimem podatkowym; przełącznik i widok zbiorczy.
- Transakcje: kupno, sprzedaż, dywidenda, odsetki, opłata, podatek, wpłata, wypłata, split.
- Koszt nabycia metodą FIFO, liczony osobno dla każdej pary portfel + instrument.
- Autouzupełnianie tickera i nazwy instrumentu.

**Analiza**
- Pulpit: wartość portfela, zmiana dzienna i tygodniowa, wynik vs wpłacony kapitał, wykres wartości w czasie, alokacja wg klas aktywów, walut, sektorów i geografii.
- XIRR całego portfela i per pozycja, porównanie z benchmarkami.
- Analiza techniczna per instrument: SMA 50/200, EMA, RSI, MACD, wykrywanie złotego krzyża i stref wykupienia.
- Dywidendy: historia, podsumowanie roczne, stopa dywidendy z ostatnich 12 miesięcy.

**Rebalans i kontrola ryzyka**
- Alokacja docelowa per klasa aktywów z tolerancją odchylenia.
- Dwa plany obok siebie: pełny rebalans (z sprzedażą) i tryb tylko dokupowania, który nie generuje zdarzenia podatkowego.
- Planer dopłat: podajesz kwotę miesięcznej wpłaty, aplikacja proponuje podział minimalizujący odchylenie.
- Ostrzeżenia o koncentracji pojedynczej spółki, sektora i nakładaniu się ETF-ów.

**Obligacje detaliczne**
- EDO, COI, TOS, ROR, DOR, ROS, ROD, OTS z parametrami emisji zapisanymi per zakup.
- Naliczanie odsetek: pierwszy rok stały, kolejne inflacja + marża, kapitalizacja roczna dla EDO.
- Okresy bez ogłoszonego odczytu inflacji są oznaczone jako prognoza.

**Monitoring i powiadomienia**
- Newsy z publicznych kanałów RSS dla spółek z portfela i watchlisty.
- Opcjonalna analiza AI: streszczenie po polsku, sentyment, waga, argumenty za trzymaniem i za redukcją.
- Alerty: cenowe, duża zmiana dzienna, odchylenie alokacji, zbliżający się raport okresowy, istotny news.

**Podatki i eksport**
- Zestawienie pomocnicze do PIT-38: papiery wartościowe i krypto rozliczane osobno, dywidendy z podatkiem u źródła.
- Eksport CSV zestawienia, pełny eksport danych do JSON, eksport transakcji do CSV.

---

## Architektura

```
shared/     typy i schematy Zod współdzielone przez backend i frontend
            + arytmetyka pieniężna (money.ts)
backend/    Express + TypeScript, SQLite przez Drizzle ORM
  drizzle/    migracje SQL
  src/
    db/         schemat bazy i migracje
    providers/  źródła cen za wspólnym interfejsem PriceProvider
    parsers/    parsery importu za wspólnym interfejsem ImportParser
    services/   logika domenowa (FIFO, XIRR, obligacje, podatki, rebalans)
    routes/     API REST pod /api/*
    jobs/       zadania cykliczne (node-cron)
frontend/   React + Vite + TypeScript + Tailwind, wykresy Recharts
data/        baza SQLite (wolumen Dockera, poza repozytorium)
```

Backend serwuje zbudowany frontend z tego samego portu, więc w produkcji działa jeden kontener i jeden port.

**Punkty rozszerzeń.** Dodanie nowego źródła cen sprowadza się do implementacji interfejsu `PriceProvider` i dopisania go do rejestru w `backend/src/providers/registry.ts`. Analogicznie nowy parser importu (np. CSV z giełdy krypto) to implementacja `ImportParser` i wpis w `backend/src/parsers/registry.ts`. Żaden istniejący kod nie wymaga wtedy zmian.

**Zadania cykliczne:**

| Zadanie | Harmonogram |
|---|---|
| Odświeżanie cen | co `PRICE_REFRESH_MINUTES`, tylko w godzinach sesji |
| Kursy NBP | 12:15 w dni robocze (po publikacji tabeli A) |
| Snapshot portfela | 23:50 codziennie |
| Benchmarki | 23:30 w dni robocze |
| Newsy + analiza AI | co godzinę |
| Kontrola alertów | co 15 minut |

---

## Reprezentacja liczb

Żadna wartość pieniężna nie jest w aplikacji liczbą zmiennoprzecinkową. Wszystko to liczby całkowite w ustalonej skali, a mnożenie i dzielenie idzie przez `BigInt`:

| Wielkość | Skala | Sufiks |
|---|---|---|
| Kwoty | minor units waluty (grosze/centy) | `_minor` |
| Ilości | ×10⁸ | `_e8` |
| Ceny | ×10⁸ | `_e8` |
| Kursy walut | ×10⁶ | `_e6` |
| Procenty | punkty bazowe (10000 = 100%) | `_bp` |

Powód jest praktyczny: `2.2301 * 1e8` w arytmetyce zmiennoprzecinkowej daje `223010000.00000003`, a `0.1 + 0.2` nie równa się `0.3`. Przy tysiącach transakcji takie błędy kumulują się w widoczne rozbieżności. Wartości wejściowe są parsowane ze stringów bez przechodzenia przez `Number` — szczegóły w [`shared/src/money.ts`](shared/src/money.ts).

---

## Źródła danych

| Dane | Źródło | Klucz API |
|---|---|---|
| Akcje, ETF-y (GPW przez sufiks `.WA`), indeksy, metale | Yahoo Finance (nieoficjalne API) | nie |
| Kryptowaluty | CoinGecko | nie |
| Kursy walut | NBP, tabela A | nie |
| Cena złota | NBP (PLN za gram) | nie |
| Newsy | publiczne kanały RSS | nie |
| Analiza newsów | Anthropic API | tak, opcjonalny |

**Stooq nie jest używany**, mimo że w wielu poradnikach figuruje jako źródło danych dla GPW. Jego endpointy CSV (`/q/l/` i `/q/d/l/`) są dziś za mechanizmem antybotowym wymagającym rozwiązania zadania proof-of-work w JavaScripcie. Obejście tego zabezpieczenia byłoby świadomym łamaniem woli operatora serwisu, więc GPW obsługiwane jest przez Yahoo Finance.

Yahoo Finance to nieoficjalne API, które może się zmienić bez zapowiedzi. Dlatego dostawcy cen mają wspólny interfejs z łańcuchem fallbacku, cache w bazie i wyłącznik obwodu: po pięciu błędach z rzędu źródło jest wyłączane na 30 minut. Brak ceny nigdy nie wywraca aplikacji — pozycja jest wyceniana ostatnią znaną ceną i oznaczana jako nieświeża.

Jako benchmark GPW używany jest **WIG20**, nie szeroki WIG — Yahoo nie publikuje tego drugiego.

---

## Import danych

Import przebiega dwuetapowo: podgląd, a potem zatwierdzenie zaznaczonych wierszy. Nic nie jest zapisywane bez decyzji użytkownika i nic nie jest nadpisywane.

**Obsługiwane formaty:**

- **XTB** — raport z xStation zapisany jako MHTML. Czytana jest sekcja `CASH OPERATION HISTORY`, jedyna zawierająca komplet zdarzeń.
- **Inwestomat** — arkusz xlsx z [inwestomat.eu](https://inwestomat.eu/wlasny-arkusz-do-monitorowania-inwestycji/). Dodatkowo z arkusza „Historia" pobierana jest historyczna wartość portfela, żeby wykres nie zaczynał się od dnia instalacji.
- **Dowolny CSV** — z kreatorem mapowania kolumn, dla źródeł bez dedykowanego parsera.

**Deduplikacja działa na dwóch poziomach:**

1. *Hash wiersza źródłowego* — ponowny import tego samego pliku jest idempotentny i nie tworzy duplikatów.
2. *Klucz logiczny* (portfel + data + instrument + typ + ilość + kwota) — wykrywa tę samą transakcję wprowadzoną wcześniej ręcznie albo pochodzącą z innego źródła. Takie wiersze są oznaczane jako konflikt i domyślnie odznaczone; scalenie wymaga świadomej decyzji.

**Uwaga o wyciągach XTB.** Platforma księguje zamknięcie pozycji w dwóch wierszach: `Stock sale` zwraca samą pierwotną wartość zakupu, a wynik trafia osobno jako `close trade`. Przychód ze sprzedaży to dopiero suma obu — parser je łączy. Wyciąg podaje też kwoty wyłącznie w walucie rachunku, więc waluta notowania jest wnioskowana z sufiksu symbolu, a kurs brokera odtwarzany z kwoty rozliczenia. Wiersze o niepewnej walucie (sufiks `.UK` obsługuje papiery zarówno w USD, jak i w GBP) są w podglądzie oznaczone do sprawdzenia.

---

## Rozliczenie podatkowe

Raport PIT-38 jest **zestawieniem pomocniczym, nie deklaracją podatkową**. Kwoty należy zweryfikować z dokumentami od brokera.

Zasady, których pilnuje aplikacja:

- **Portfele IKE i IKZE są wyłączone z zestawienia** — zyski z nich są zwolnione z podatku od zysków kapitałowych. Są pokazane jako wykluczone, żeby było widać, że nie zostały pominięte przez pomyłkę.
- **Krypto rozliczane osobno** od papierów wartościowych.
- **Podstawą jest kurs NBP z dnia poprzedzającego transakcję (D-1)**, a nie kurs rozliczeniowy brokera.
- **Dywidendy zagraniczne** uwzględniają podatek u źródła z limitem odliczenia 19%.

Ostatni punkt wymaga wyjaśnienia, bo aplikacja przechowuje dwie różne kwoty dla każdej transakcji walutowej. Kupując akcje Novo Nordisk za 173,25 DKK, XTB pobrał 100,03 zł po własnym kursie, ale kurs NBP z dnia poprzedzającego daje 99,05 zł. Obie liczby są poprawne w swoim kontekście: pierwsza to faktyczny przepływ gotówki i musi się zgadzać z wyciągiem, druga to podstawa podatkowa. Trzymanie tylko jednej z nich oznaczałoby albo saldo niezgodne z brokerem, albo błędnie policzony podatek.

---

## Dostęp spoza domu

Nie wystawiaj portu 8080 na router. Zamiast tego zainstaluj [Tailscale](https://tailscale.com/) na serwerze i telefonie — aplikacja nie wymaga żadnych zmian, wchodzisz przez adres tailnetowy serwera na ten sam port.

Jeśli stawiasz przed aplikacją reverse proxy z HTTPS, ustaw `COOKIE_SECURE=true` w `.env`.

---

## Kopie zapasowe

Cały stan aplikacji siedzi w katalogu `data/`. Skopiowanie go wystarcza do przeniesienia instalacji na inny serwer.

Skrypt [`scripts/backup.sh`](scripts/backup.sh) robi spójną kopię przez polecenie `.backup` SQLite (zwykłe kopiowanie pliku przy włączonym WAL potrafi dać niespójny wynik), kompresuje ją i rotuje stare kopie.

```bash
./scripts/backup.sh

# Codziennie o 3:30 przez crona:
30 3 * * * /opt/portfolio-manager/scripts/backup.sh >> /var/log/pm-backup.log 2>&1
```

Niezależnie od tego w Ustawieniach dostępny jest pełny eksport danych do JSON.

---

## Rozwój lokalny

```bash
npm install
cp .env.example .env          # ustaw APP_PASSWORD i SESSION_SECRET
npm run db:migrate
npm run dev                   # backend :8080, frontend :5173 z proxy na /api
```

| Polecenie | Działanie |
|---|---|
| `npm run dev` | backend i frontend równolegle |
| `npm run build` | build produkcyjny |
| `npm test` | testy jednostkowe (Vitest) |
| `npm run typecheck` | sprawdzenie typów we wszystkich pakietach |
| `npm run db:generate` | wygenerowanie migracji z zmian w schemacie |
| `npm run db:migrate` | zastosowanie migracji |

Testami objęte są: FIFO (w tym rozdział portfeli i sprzedaże częściowe), arytmetyka pieniężna, XIRR, wskaźniki techniczne, parsery importu, logika rebalansu, wykrywanie koncentracji i naliczanie odsetek od obligacji.

---

## Ograniczenia

Rzeczy, o których warto wiedzieć przed użyciem:

- **Yahoo Finance i CoinGecko to nieoficjalne API.** Mogą przestać działać bez zapowiedzi. Cache w bazie sprawia, że aplikacja nadal działa, ale wyceny się zestarzeją.
- **Waluta notowania w imporcie XTB jest wnioskowana** z sufiksu symbolu. Dla `.UK` domyślnie przyjmowany jest USD; jeśli trzymasz brytyjskie akcje notowane w GBP, sprawdź walutę na instrumencie po imporcie.
- **Wykrywanie nakładania się ETF-ów wymaga uzupełnienia składu funduszu** na instrumencie. Bez tych danych aplikacja milczy, zamiast zgadywać skład po nazwie.
- **Raport podatkowy nie obsługuje rozliczania strat z lat ubiegłych** ani sytuacji nietypowych (splity z wypłatą gotówki, transfery między brokerami, spin-offy).
- **Sygnały techniczne i analiza AI są materiałem informacyjnym**, nie rekomendacją ani doradztwem inwestycyjnym.
- **Aplikacja zakłada jednego użytkownika.** Nie ma ról, uprawnień ani audytu dostępu.

---

## Licencja

MIT — zobacz [LICENSE](LICENSE).
