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
