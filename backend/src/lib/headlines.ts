/**
 * Obróbka nagłówków z kanałów RSS.
 */

/**
 * Odcięcie nazwy wydawcy z końca tytułu.
 *
 * Wyszukiwarka Google News dokleja „ - Nazwa serwisu". Przy brokerach
 * prowadzących własny serwis analityczny jest to pułapka: „Akcje Alphabet
 * wypadły z łask - XTB.com" to materiał XTB o Alphabecie, a nie wiadomość
 * o spółce XTB. Bez tego cięcia analiza kursu dostawała cudze komentarze
 * rynkowe jako newsy o analizowanej spółce.
 */
export function stripPublisher(title: string): string {
  const cut = title.lastIndexOf(' - ');
  // Wydawca to krótki człon na końcu; dłuższy fragment to część właściwego tytułu.
  return cut > 0 && title.length - cut <= 40 ? title.slice(0, cut) : title;
}

/**
 * Konteksty, w których nazwa spółki pojawia się poza rynkiem kapitałowym.
 *
 * Sponsoring sportowy jest tu głównym sprawcą: „XTB KSW 120. Karta walk i wyniki
 * gali" trafia w każdy filtr po nazwie, a o notowaniach nie mówi nic. Analiza
 * ruchu kursu karmiona takimi tytułami szuka wyjaśnień tam, gdzie ich nie ma.
 */
const OFF_TOPIC = [
  'ksw',
  'gala',
  'gali',
  'karta walk',
  'ważeni',
  'mecz',
  'turniej',
  'puchar',
  'liga',
  'piłkar',
  'siatkar',
  'koszykar',
  'zawodnik',
  'bilety',
  'koncert',
  'festiwal',
  'transmisja',
  'na żywo',
  'relacja live',
];

/** Słowa, po których widać, że tekst dotyczy rynku. */
const MARKET_TERMS = [
  'akcj',
  'kurs',
  'giełd',
  'notowan',
  'rekomendacj',
  'wycen',
  'zysk',
  'strat',
  'przychod',
  'dywidend',
  'wyniki finansow',
  'kwartał',
  'raport',
  'prezes',
  'zarząd',
  'inwestor',
  'wig',
  'gpw',
  'emisj',
  'walne',
  'obligacj',
  'przejęci',
  'fuzj',
  'kapitał',
];

/**
 * Czy nagłówek dotyczy rynku kapitałowego.
 *
 * Kontekst pozarynkowy przeważa nad słowem rynkowym: „wyniki gali" zawiera
 * „wyniki", a mimo to nie ma nic wspólnego z notowaniami.
 */
export function looksMarketRelated(title: string): boolean {
  const text = title.toLowerCase();
  if (OFF_TOPIC.some((word) => text.includes(word))) return false;
  return MARKET_TERMS.some((word) => text.includes(word));
}


/**
 * Waga nagłówka dla wyjaśnienia ruchu kursu.
 *
 * Kanał zwraca kilkanaście tekstów o spółce, ale nie są równe: komunikat
 * o rekomendacji albo wynikach mówi o wycenie wprost, a zbiorczy przegląd sesji
 * wspomina spółkę mimochodem. Bez uszeregowania model budował wątek wokół tego,
 * co akurat trafiło się pierwsze.
 *
 * Wyższa liczba znaczy ważniejszy tekst.
 */
const IMPORTANCE_RULES: { match: RegExp; weight: number }[] = [
  // Zdarzenia raportowane obowiązkowo — najsilniej wiążą się z kursem.
  { match: /espi|raport bieżący|komunikat giełdowy|walne zgromadzenie/i, weight: 10 },
  { match: /rekomendacj|wycen|cena docelowa|podnieśli|obniżyli|kupuj|sprzedaj|trzymaj/i, weight: 9 },
  { match: /wyniki (finansow|za |kwartał)|zysk netto|przychody|ebitda|prognoz|guidance/i, weight: 8 },
  { match: /dywidend|skup akcji|buyback|split|emisj[aę] akcji|wykup/i, weight: 8 },
  { match: /przejęci|fuzj|akwizycj|sprzedaż aktywów|kontrakt|umow[aę]/i, weight: 7 },
  { match: /prezes|zarząd|rada nadzorcza|dymisj|rezygnacj|powołan/i, weight: 6 },
  { match: /zarzut|prokuratur|śledztw|kara |ochrony konkurencji|regulator|sankcj/i, weight: 6 },
  { match: /strajk|awari|pożar|wypadek|przestój/i, weight: 5 },
  // Przeglądy sesji wspominają spółkę przy okazji.
  { match: /przegląd|podsumowanie sesji|notowania na żywo|wig20 |zamknięcie sesji/i, weight: 2 },
];

export function headlineImportance(title: string, summary?: string | null): number {
  const text = `${title} ${summary ?? ''}`;
  return IMPORTANCE_RULES.find((rule) => rule.match.test(text))?.weight ?? 4;
}

/**
 * Otoczenie sektorowe: co poza samą spółką rusza jej kursem.
 *
 * Decyzja rządu o regulowaniu cen paliw uderza w rafinerie, choć nazwa spółki
 * nie pada w niej ani razu. Filtrowanie po nazwie takie teksty przepuszcza,
 * a bywają one ważniejsze niż wszystko, co spółka sama ogłosiła. Stąd drugi
 * strumień: wiadomości dobierane po branży i po tym, że dotyczą regulacji,
 * podatków albo cen surowców.
 *
 * `query` służy do dociągnięcia materiału, `keywords` do wyłowienia go
 * z wiadomości już zebranych.
 */
export interface SectorContext {
  query: string;
  keywords: string[];
}

const SECTOR_CONTEXTS: { match: RegExp; context: SectorContext }[] = [
  {
    match: /energet|paliw|ropa|rafiner|oil|gas|energy/i,
    context: {
      query: 'ceny paliw regulacje rząd akcyza ropa naftowa',
      keywords: ['cen paliw', 'ceny paliw', 'akcyz', 'ropa', 'rafiner', 'marż', 'opłata paliwow', 'orlen', 'gaz'],
    },
  },
  {
    match: /finans|bank|ubezpiecz|financial|insurance/i,
    context: {
      query: 'stopy procentowe RPP banki podatek regulacje KNF',
      keywords: ['stop procentow', 'rpp', 'wibor', 'kredyt', 'knf', 'podatek bankow', 'wakacje kredytow', 'frank'],
    },
  },
  {
    match: /surowc|metal|górnic|mining|materials/i,
    context: {
      query: 'ceny miedzi surowce podatek wydobywczy',
      keywords: ['miedz', 'podatek wydobywcz', 'cen surowc', 'ruda', 'wydobyci'],
    },
  },
  {
    match: /użyteczn|komunaln|utilit|power/i,
    context: {
      query: 'ceny energii taryfy URE mrożenie cen prądu',
      keywords: ['ceny energii', 'taryf', 'ure', 'mrożeni', 'prąd', 'węgiel', 'emisj'],
    },
  },
  {
    match: /technolog|technology|gaming|komunikac|communication/i,
    context: {
      query: 'regulacje technologiczne podatek cyfrowy AI',
      keywords: ['podatek cyfrow', 'regulacj', 'sztuczn', 'dane osobow', 'unia europejska'],
    },
  },
  {
    match: /zdrow|health|pharma/i,
    context: {
      query: 'refundacja leków NFZ regulacje farmaceutyczne',
      keywords: ['refundacj', 'nfz', 'lek', 'ministerstwo zdrowia'],
    },
  },
  {
    match: /konsump|handel|retail|consumer/i,
    context: {
      query: 'handel w niedzielę VAT sprzedaż detaliczna inflacja',
      keywords: ['handel w niedziel', 'vat', 'sprzedaż detaliczn', 'inflacj', 'płaca minimaln'],
    },
  },
  {
    match: /nieruchom|real estate|budown/i,
    context: {
      query: 'kredyty hipoteczne ceny mieszkań program mieszkaniowy',
      keywords: ['hipotecz', 'ceny mieszka', 'program mieszkaniow', 'budownictw'],
    },
  },
];

/** Otoczenie właściwe dla sektora; null, gdy sektor nieznany albo nieobsługiwany. */
export function sectorContext(sector: string | null): SectorContext | null {
  if (!sector) return null;
  return SECTOR_CONTEXTS.find((entry) => entry.match.test(sector))?.context ?? null;
}

/** Sygnały, że wiadomość dotyczy decyzji państwa — istotne dla każdej branży. */
const POLICY_TERMS = [
  'rząd',
  'premier',
  'ministerstw',
  'minister ',
  'sejm',
  'ustaw',
  'rozporządzeni',
  'regulacj',
  'podatek',
  'podatku',
  'akcyz',
  'urząd',
  'komisja europejska',
  'prezes rady ministrów',
];

/** Czy nagłówek opisuje decyzję władz, która może dotknąć całą branżę. */
export function looksPolicyRelated(title: string, summary?: string | null): boolean {
  const text = `${title} ${summary ?? ''}`.toLowerCase();
  return POLICY_TERMS.some((term) => text.includes(term));
}
