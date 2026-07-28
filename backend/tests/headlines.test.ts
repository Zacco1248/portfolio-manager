import { describe, expect, it } from 'vitest';
import { looksMarketRelated, stripPublisher } from '../src/lib/headlines.js';
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
