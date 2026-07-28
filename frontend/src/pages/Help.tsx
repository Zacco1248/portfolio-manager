import { Link } from 'react-router-dom';
import { Card } from '@/components/ui';
import { useApp } from '@/state/app';

/**
 * Wprowadzenie do aplikacji.
 *
 * Nie powiela README — tłumaczy model danych i decyzje, które inaczej byłyby
 * zaskoczeniem: dlaczego są dwie kwoty w PLN, czemu terminy dywidend są
 * prognozą i skąd biorą się ostrzeżenia o nieaktualnych cenach.
 */
export function Help() {
  const { status } = useApp();

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <Card title="Od czego zacząć">
        <ol className="space-y-2 p-4 pt-2 text-sm">
          <Step number={1} title="Dodaj portfele">
            W <Link className="text-accent hover:underline" to="/ustawienia">Ustawieniach</Link> utwórz po jednym
            portfelu na każdy rachunek. Ustaw reżim podatkowy — IKE i IKZE są zwolnione z podatku Belki i aplikacja
            wyłączy je z raportu PIT-38.
          </Step>
          <Step number={2} title="Zaimportuj historię">
            W widoku <Link className="text-accent hover:underline" to="/import">Import</Link> wrzuć wyciąg z XTB
            (plik MHTML z xStation) albo arkusz Inwestomatu. Import pokazuje podgląd — nic nie zapisuje się bez
            Twojego zatwierdzenia.
          </Step>
          <Step number={3} title="Ustaw alokację docelową">
            W <Link className="text-accent hover:underline" to="/rebalans">Rebalansie</Link> określ, jaki procent
            portfela ma przypadać na każdą klasę aktywów. Bez tego nie ma z czym porównywać stanu bieżącego.
          </Step>
          <Step number={4} title="Włącz powiadomienia">
            Opcjonalnie: uzupełnij <code>TELEGRAM_BOT_TOKEN</code> i <code>ANTHROPIC_API_KEY</code> w pliku
            <code> .env</code> na serwerze. Bez nich aplikacja działa, tylko bez powiadomień push i bez streszczeń
            newsów.
          </Step>
        </ol>
      </Card>

      <Card title="Jak to liczy">
        <div className="space-y-3 p-4 pt-2 text-sm">
          <Item title="Źródłem prawdy są transakcje">
            Nie ma osobnej tabeli ze stanem posiadania. Pozycje, zysk i podatek są wyliczane z transakcji przy
            każdym odświeżeniu. Dlatego dodanie transakcji sprzed roku poprawnie przebuduje całą historię.
          </Item>

          <Item title="Koszt nabycia metodą FIFO, osobno w każdym portfelu">
            Sprzedaż zabiera najstarsze zakupy. Partie nigdy nie przechodzą między portfelami — sprzedaż w IKE nie
            sięgnie po tańsze akcje z rachunku zwykłego.
          </Item>

          <Item title="Dwie kwoty w złotych przy transakcjach walutowych">
            Jedna to faktyczny przepływ po kursie brokera — musi zgadzać się z wyciągiem. Druga to podstawa
            podatkowa po kursie NBP z dnia poprzedzającego transakcję. To nie pomyłka, tylko dwie różne liczby
            wymagane do dwóch różnych celów.
          </Item>

          <Item title="Średnia cena nabycia jest w złotych">
            Pozycja kupowana przy różnych kursach walutowych nie ma jednej ceny w walucie notowania — pokazanie
            takiej wartości sugerowałoby cenę, której nigdy nie zapłaciłeś.
          </Item>

          <Item title="XIRR zamiast zwykłego procentu">
            Przy comiesięcznych dopłatach procent zysku niewiele mówi, bo każda wpłata pracowała inny czas.
            <Link className="text-accent hover:underline" to="/analiza"> Analiza</Link> pokazuje XIRR — roczną stopę
            uwzględniającą terminy przepływów.
          </Item>
        </div>
      </Card>

      <Card title="Czego aplikacja nie wie">
        <div className="space-y-3 p-4 pt-2 text-sm">
          <Item title="Terminy dywidend są prognozą">
            Darmowe źródła nie podają przyszłych dat ustalenia prawa. Kalendarz wylicza je z rytmu poprzednich
            wypłat i jest wyraźnie oznaczony jako prognoza.
          </Item>

          <Item title="Terminy raportów wprowadzasz ręcznie">
            Nie ma darmowego API z harmonogramami. Po wpisaniu daty w widoku Dywidendy alert przypomni o zbliżającym
            się terminie.
          </Item>

          <Item title="Skład ETF-ów podajesz sam">
            Wykrywanie nakładania się funduszy wymaga wiedzy, jakie spółki trzymają. Wklej skład ze strony emitenta
            w Ustawieniach — bez tych danych aplikacja milczy, zamiast zgadywać po nazwie.
          </Item>

          <Item title="Ceny bywają nieaktualne">
            Źródła notowań są nieoficjalnymi API. Gdy nie odpowiadają, pozycja jest wyceniana ostatnią znaną ceną
            i oznaczona etykietą „stara cena”. Stan źródeł widać w Ustawieniach.
          </Item>

          <Item title="Sygnały i analiza AI to materiał informacyjny">
            Nie są rekomendacją ani doradztwem inwestycyjnym. Wskaźniki techniczne opisują to, co już się wydarzyło.
          </Item>
        </div>
      </Card>

      <Card title="Poduszka finansowa">
        <div className="space-y-3 p-4 pt-2 text-sm">
          <p className="text-content-secondary">
            Poduszkę wskazujesz na dwa sposoby i oba liczą się jednocześnie. Aplikacja sumuje je i porównuje
            z celem, który ustawiasz jako liczbę miesięcy wydatków (Ustawienia → miesięczne wydatki i liczba miesięcy).
          </p>

          <Item title="Całym portfelem">
            Dla środków trzymanych osobno — konto oszczędnościowe, lokata, gotówka. Załóż portfel, zaznacz mu
            w Ustawieniach „poduszka finansowa" i zaksięguj stan jedną transakcją typu <em>Wpłata</em>.
            Dopisane odsetki wprowadzasz typem <em>Odsetki</em> — dzięki temu policzy się też ich stopa zwrotu.
          </Item>

          <Item title="Pojedynczymi pozycjami">
            Dla instrumentów leżących w portfelu inwestycyjnym. Wejdź w pozycję z listy, na karcie „Klasyfikacja"
            zaznacz „Wlicza się do poduszki finansowej". Nic nie trzeba przenosić — historia i FIFO zostają nietknięte.
          </Item>

          <Item title="Przykład">
            Wydatki 4 000 zł/mies., cel 6 miesięcy, czyli 24 000 zł. Masz konto oszczędnościowe na 9 000 zł
            (osobny portfel z flagą) i obligacje COI za 12 000 zł w portfelu wspólnym (pozycja zaznaczona ręcznie).
            Poduszka to 21 000 zł, pokrycie 5,3 miesiąca, realizacja celu 88%. Akcje z tego samego portfela
            nie są liczone, bo nie mają zaznaczonej flagi.
          </Item>

          <Item title="Co wliczać, a czego nie">
            Wliczaj to, co odzyskasz w dzień–dwa bez straty: konto oszczędnościowe, lokatę z niską karą,
            obligacje TOS i COI (wykup kosztuje 0,70 zł od sztuki). EDO raczej nie — przedterminowy wykup
            zjada narosłe odsetki, a właśnie one są tam całym sensem. Akcji, ETF-ów i krypto nie wliczaj
            niezależnie od płynności: poduszka ma być pewna wtedy, kiedy rynek nie jest, a te rzeczy tanieją
            dokładnie wtedy, gdy człowiek traci pracę.
          </Item>
        </div>
      </Card>

      <Card title="Co wychodzi na zewnątrz">
        <div className="space-y-3 p-4 pt-2 text-sm">
          <p className="text-content-secondary">
            Baza, transakcje i wszystkie wyliczenia są wyłącznie na Twoim serwerze. Aplikacja nie ma telemetrii
            ani zewnętrznych zasobów we froncie. Do internetu odzywa się jednak po dane rynkowe — także przy
            całkowicie wyłączonym AI.
          </p>

          <Item title="Zawsze, niezależnie od ustawień AI">
            <strong>Yahoo Finance</strong> — tickery instrumentów, które masz w portfelu.{' '}
            <strong>NBP</strong> — kursy walut, zapytanie bez żadnych Twoich danych.{' '}
            <strong>CoinGecko</strong> — nazwy kryptowalut.{' '}
            <strong>Kanały RSS</strong> (PAP, Puls Biznesu i pozostałe) — pobierane w całości, bez wysyłania czegokolwiek.
            Wychodzą więc <em>nazwy instrumentów</em>, nigdy stany posiadania, kwoty, transakcje ani wyniki.
            Zapytania idą z serwera, nie z przeglądarki.
          </Item>

          <Item title="Model językowy — tylko po świadomym włączeniu">
            Bez klucza w <code>.env</code> i bez zaznaczenia konkretnej funkcji do dostawcy modelu nie idzie nic.
            Sama obecność klucza nie wystarcza. Każda funkcja jest osobnym przełącznikiem i przy każdej widzisz
            w Ustawieniach dokładny zakres wysyłanych danych — jedne dostają tylko udziały procentowe,
            inne kwoty zagregowane, streszczanie dokumentów wyłącznie tekst, który sam wkleisz.
          </Item>

          <Item title="Telegram — jedyne miejsce z kwotami">
            Po skonfigurowaniu powiadomień treść alertów idzie przez serwery Telegrama i tam znajdą się konkretne
            liczby. Bez konfiguracji funkcja jest wyłączona.
          </Item>

          <Item title="Czego nie ma">
            Żadnych kont w chmurze, synchronizacji, kopii zapasowych na zewnątrz ani analityki użycia.
            Kopię zapasową robisz sam, kopiując katalog <code>./data</code>.
          </Item>
        </div>
      </Card>

      <Card title="Powiadomienia na Telegramie">
        <div className="space-y-3 p-4 pt-2 text-sm">
          <p className="text-content-secondary">
            Opcjonalne. Bez konfiguracji alerty widać wyłącznie w aplikacji — nic nie przestaje działać,
            po prostu trzeba do niej zajrzeć. Z Telegramem alert przychodzi na telefon w chwili wykrycia.
          </p>

          <Item title="1. Załóż bota">
            W Telegramie napisz do <code>@BotFather</code>, wyślij <code>/newbot</code> i podaj nazwę
            oraz login bota (musi kończyć się na „bot", np. <code>moj_portfel_bot</code>).
            W odpowiedzi dostaniesz token w postaci <code>123456789:AAE...</code> — to jest
            <code> TELEGRAM_BOT_TOKEN</code>.
          </Item>

          <Item title="2. Odblokuj bota">
            Wejdź w profil swojego świeżo utworzonego bota i naciśnij <strong>Start</strong>. Bez tego
            Telegram nie pozwoli mu napisać do Ciebie pierwszy — dostaniesz błąd „chat not found",
            nawet przy poprawnym tokenie.
          </Item>

          <Item title="3. Ustal swój chat_id">
            Napisz do <code>@userinfobot</code> — odpowie Twoim numerem identyfikacyjnym, np.
            <code> 123456789</code>. To jest <code>TELEGRAM_CHAT_ID</code>. Jeśli wolisz dostawać
            powiadomienia na grupę, dodaj do niej bota i użyj identyfikatora grupy — będzie ujemny,
            np. <code>-1001234567890</code>.
          </Item>

          <Item title="4. Wpisz do .env i zrestartuj">
            Na serwerze otwórz <code>.env</code>, uzupełnij <code>TELEGRAM_BOT_TOKEN</code> oraz{' '}
            <code>TELEGRAM_CHAT_ID</code>, zapisz i wykonaj <code>docker compose up -d</code>.
            Plik czytany jest przy starcie, więc bez restartu zmiana nie zadziała.
          </Item>

          <Item title="5. Sprawdź">
            W Alertach użyj przycisku sprawdzania alertów. Jeśli któryś się wyzwoli, wiadomość
            powinna przyjść na Telegram. Cisza mimo wyzwolonego alertu oznacza zwykle pominięty
            krok 2 albo literówkę w identyfikatorze.
          </Item>

          <p className="text-2xs text-content-muted">
            To jedyna integracja, w której na zewnątrz trafiają konkretne kwoty — treść alertu przechodzi
            przez serwery Telegrama. Token trzymaj tylko w <code>.env</code>; kto go ma, może pisać jako Twój bot.
          </p>
        </div>
      </Card>

      <Card title="Co potrafi asystent">
        <div className="space-y-3 p-4 pt-2 text-sm">
          <p className="text-content-secondary">
            Wszystkie funkcje modelu działają tak samo: liczby powstają lokalnie z bazy, model dostaje gotowe
            wnioski i układa z nich zdania. Wyłączenie AI odbiera komentarz, nie odbiera danych.
            Żadna z nich nie wydaje rekomendacji inwestycyjnych.
          </p>

          <Item title="Zakładka Asystent">
            <strong>Podsumowanie miesiąca</strong> — co się zmieniło, ile z tego to wynik, a ile dopłaty.{' '}
            <strong>Kontrola przed zakupem</strong> — wpisujesz instrument i kwotę, dostajesz wpływ na udziały
            klasy, sektora i regionu wraz z ostrzeżeniami o koncentracji.{' '}
            <strong>Asystent podatkowy</strong> — pytania o Twoje konkretne zestawienie PIT-38.{' '}
            <strong>Streszczanie dokumentów</strong> — wklejasz raport okresowy albo prospekt, dostajesz
            streszczenie po polsku z liczbami i ryzykami wskazanymi przez samą spółkę.
          </Item>

          <Item title="W innych miejscach">
            Na karcie instrumentu <strong>„Dlaczego kurs się ruszył"</strong> zestawia zmianę z dwóch tygodni
            z wiadomościami z tego okresu — i mówi wprost, kiedy nagłówki ruchu nie tłumaczą. W Aktualnościach
            streszczenia i ocena wydźwięku, w Rebalansie kierunki uzupełnienia portfela, w Postępach komentarz
            do podsumowania, w Imporcie podpowiedź mapowania kolumn nieznanego pliku.
          </Item>
        </div>
      </Card>

      <Card title="Co działa w tle">
        <ul className="space-y-1.5 p-4 pt-2 text-sm">
          <Cron when="co 15 minut, w godzinach sesji">odświeżanie cen instrumentów</Cron>
          <Cron when="12:15 w dni robocze">kursy walut z tabeli A NBP</Cron>
          <Cron when="23:50 codziennie">zapis wartości portfela — z tego powstaje wykres historyczny</Cron>
          <Cron when="co godzinę">pobieranie newsów{status?.features.ai ? ' i analiza AI' : ' (analiza AI wyłączona)'}</Cron>
          <Cron when="co 15 minut">sprawdzanie alertów</Cron>
        </ul>
        <p className="px-4 pb-4 text-2xs text-content-muted">
          Historia wartości portfela zaczyna się od dnia uruchomienia aplikacji. Wcześniejszą można wnieść wyłącznie
          importem arkusza Inwestomatu.
        </p>
      </Card>
    </div>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-2xs font-semibold text-accent">
        {number}
      </span>
      <div>
        <div className="font-medium">{title}</div>
        <p className="mt-0.5 text-content-secondary">{children}</p>
      </div>
    </li>
  );
}

function Item({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="font-medium">{title}</div>
      <p className="mt-0.5 text-content-secondary">{children}</p>
    </div>
  );
}

function Cron({ when, children }: { when: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="tabular w-44 shrink-0 text-2xs text-content-muted">{when}</span>
      <span className="text-content-secondary">{children}</span>
    </li>
  );
}
