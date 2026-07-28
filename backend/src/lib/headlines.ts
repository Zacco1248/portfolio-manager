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
