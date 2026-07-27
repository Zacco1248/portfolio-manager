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
