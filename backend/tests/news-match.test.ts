import { describe, expect, it } from 'vitest';
import { mentionsInstrument } from '../src/services/ai-assist.js';

const xtb = { symbol: 'WSE:XTB', name: 'XTB S.A.' };
const orlen = { symbol: 'WSE:PKN', name: 'Orlen S.A.' };

describe('dopasowanie wiadomości do spółki', () => {
  it('łapie ticker w nagłówku', () => {
    expect(mentionsInstrument('XTB z rekordowym kwartałem', xtb)).toBe(true);
    expect(mentionsInstrument('Wyniki PKN Orlen za II kwartał', orlen)).toBe(true);
  });

  it('łapie nazwę spółki bez tickera', () => {
    expect(mentionsInstrument('Orlen kupuje udziały w spółce gazowej', orlen)).toBe(true);
  });

  it('działa niezależnie od wielkości liter i interpunkcji', () => {
    expect(mentionsInstrument('Akcje xtb rosną po publikacji danych.', xtb)).toBe(true);
    expect(mentionsInstrument('(XTB) — komunikat bieżący', xtb)).toBe(true);
  });

  it('nie łapie tickera w środku innego słowa', () => {
    expect(mentionsInstrument('Nowe pokoje hotelowe w Warszawie', { symbol: 'WSE:PKO', name: 'PKO BP' })).toBe(false);
    expect(mentionsInstrument('Kontrabanda na granicy', xtb)).toBe(false);
  });

  it('nie przypisuje wiadomości o innej spółce', () => {
    expect(mentionsInstrument('Wyniki Allegro za II kwartał', xtb)).toBe(false);
    expect(mentionsInstrument('XTB z rekordowym kwartałem', orlen)).toBe(false);
  });

  it('ignoruje sufiks rynku w symbolu dostawcy', () => {
    expect(mentionsInstrument('Orlen podnosi prognozy', { symbol: 'PKN.WA', name: 'Orlen S.A.' })).toBe(true);
  });
});

/**
 * Regres dla WSE:BIO.
 *
 * `services/news.ts` miał własną kopię matchera opartą na gołym `includes`,
 * przez co trzyliterowy ticker „BIO" łapał „biorą", „odbiorą" i „biopaliwa"
 * w czterech zbiorczych kanałach polskich serwisów — dziesiątki wiadomości
 * dziennie o cudzych sprawach. Pipeline pobierania korzysta teraz z tej samej
 * implementacji co rekomendacje, więc te przypadki muszą zostać odsiane.
 */
describe('WSE:BIO — trzyliterowy ticker w środku polskich słów', () => {
  const biomed = { symbol: 'WSE:BIO', name: 'Biomed-Lublin SA' };

  it('nie łapie odmiany czasownika „brać"', () => {
    expect(mentionsInstrument('Władze w Bejrucie biorą się za Hezbollah', biomed)).toBe(false);
    expect(mentionsInstrument('Turyści odbiorą odszkodowania za odwołane rezerwacje', biomed)).toBe(false);
  });

  it('nie łapie wyrazów zaczynających się od „bio"', () => {
    expect(mentionsInstrument('Biopaliwa drugiej generacji z odpadów rolnych', biomed)).toBe(false);
    expect(mentionsInstrument('Rynek biotechnologii rośnie w tempie 12% rocznie', biomed)).toBe(false);
    expect(mentionsInstrument('Nowa biografia założyciela Amazona', biomed)).toBe(false);
  });

  it('nadal łapie właściwą spółkę — po tickerze i po odmienionej nazwie', () => {
    expect(mentionsInstrument('Akcje BIO w górę po komunikacie', biomed)).toBe(true);
    expect(mentionsInstrument('Wyniki Biomedu powyżej oczekiwań', biomed)).toBe(true);
    expect(mentionsInstrument('Biomed-Lublin z umową na szczepionki', biomed)).toBe(true);
  });
});
