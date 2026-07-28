import { describe, expect, it } from 'vitest';
import {
  headlineImportance,
  looksMarketRelated,
  looksPolicyRelated,
  sectorContext,
  stripPublisher,
} from '../src/lib/headlines.js';
import { mentionsInstrument } from '../src/services/ai-assist.js';

const xtb = { symbol: 'WSE:XTB', name: 'XTB S.A.' };

describe('odcięcie nazwy wydawcy', () => {
  it('usuwa krótki człon po myślniku na końcu', () => {
    expect(stripPublisher('Dwaj analitycy podnieśli wycenę XTB - pb.pl')).toBe(
      'Dwaj analitycy podnieśli wycenę XTB',
    );
  });

  it('zostawia myślnik będący częścią tytułu', () => {
    const title = 'Rekordowy kwartał - wyniki znacznie powyżej oczekiwań analityków rynkowych';
    expect(stripPublisher(title)).toBe(title);
  });

  it('nie tnie tytułu bez myślnika', () => {
    expect(stripPublisher('Orlen podnosi prognozy')).toBe('Orlen podnosi prognozy');
  });
});

describe('materiał wydawcy o cudzej spółce', () => {
  it('nie uchodzi za wiadomość o wydawcy', () => {
    // Materiał XTB o Alphabecie — nazwa spółki występuje wyłącznie jako wydawca.
    expect(mentionsInstrument('Akcje Alphabet wypadły z łask Wall Street - XTB.com', xtb)).toBe(false);
    expect(mentionsInstrument('Verizon publikuje rekordowe wyniki, akcje rosną 4% - XTB', xtb)).toBe(false);
  });

  it('wiadomość o samej spółce przechodzi mimo obcego wydawcy', () => {
    expect(mentionsInstrument('Wyniki XTB obronią wzrost kursu akcji? - Parkiet', xtb)).toBe(true);
  });
});

describe('odsiew treści nierynkowych', () => {
  it('odrzuca sponsoring sportowy mimo słowa „wyniki"', () => {
    expect(looksMarketRelated('XTB KSW 120. Karta walk i wyniki gali na żywo')).toBe(false);
    expect(looksMarketRelated('Wyniki porannego ważenia przed galą XTB KSW 117')).toBe(false);
  });

  it('przepuszcza wiadomości giełdowe', () => {
    expect(looksMarketRelated('Dwaj analitycy podnieśli wycenę XTB')).toBe(true);
    expect(looksMarketRelated('Orlen na szczycie, akcje biją historyczny rekord')).toBe(true);
    expect(looksMarketRelated('XTB bije rekordy. Kolejny mocny kwartał')).toBe(true);
  });

  it('odrzuca nagłówek bez żadnego kontekstu rynkowego', () => {
    expect(looksMarketRelated('Nowa siedziba firmy w centrum miasta')).toBe(false);
  });
});

describe('waga nagłówka', () => {
  it('komunikat giełdowy przed rekomendacją, rekomendacja przed przeglądem sesji', () => {
    const espi = headlineImportance('Orlen: raport bieżący nr 42/2026');
    const rec = headlineImportance('Dwaj analitycy podnieśli wycenę XTB');
    const review = headlineImportance('Przegląd rynkowy: europejskie akcje odbijają');

    expect(espi).toBeGreaterThan(rec);
    expect(rec).toBeGreaterThan(review);
  });

  it('wyniki i dywidenda ważą więcej niż nagłówek bez kategorii', () => {
    const neutral = headlineImportance('Orlen otwiera nową stację w Poznaniu');
    expect(headlineImportance('Wyniki za II kwartał powyżej oczekiwań')).toBeGreaterThan(neutral);
    expect(headlineImportance('Zarząd rekomenduje wypłatę dywidendy')).toBeGreaterThan(neutral);
  });

  it('sortowanie stawia rekomendację nad przeglądem sesji', () => {
    const sorted = [
      { title: 'Przegląd sesji na GPW' },
      { title: 'Analityk Citi wydał rekomendację dla XTB' },
    ]
      .map((h) => ({ ...h, importance: headlineImportance(h.title) }))
      .sort((a, b) => b.importance - a.importance);

    expect(sorted[0]?.title).toContain('rekomendację');
  });
});

describe('otoczenie branżowe', () => {
  it('dobiera słownik do sektora', () => {
    expect(sectorContext('Energetyka')?.keywords).toContain('akcyz');
    expect(sectorContext('Finanse')?.keywords).toContain('rpp');
    expect(sectorContext(null)).toBeNull();
    expect(sectorContext('Sektor którego nie znamy')).toBeNull();
  });

  it('rozpoznaje decyzje władz', () => {
    expect(looksPolicyRelated('Rząd rozważa powrót do regulowanych cen paliw')).toBe(true);
    expect(looksPolicyRelated('Sejm przyjął ustawę o podatku od nadmiarowych zysków')).toBe(true);
    expect(looksPolicyRelated('Spółka otworzyła nową stację')).toBe(false);
  });
});

describe('polska odmiana nazwy spółki', () => {
  const orlen = { symbol: 'WSE:PKN', name: 'Orlen S.A.' };

  it('łapie nazwę w przypadkach zależnych', () => {
    expect(mentionsInstrument('Przecena Orlenu pogrzebała szanse na dobry wynik', orlen)).toBe(true);
    expect(mentionsInstrument('Inwestorzy kupują akcje Orlenu', orlen)).toBe(true);
    expect(mentionsInstrument('Rozmowa z prezesem Orlenem', orlen)).toBe(true);
  });

  it('nie rozciąga dopasowania na obce słowa', () => {
    expect(mentionsInstrument('Nowy orzeł na godle', orlen)).toBe(false);
  });
});
