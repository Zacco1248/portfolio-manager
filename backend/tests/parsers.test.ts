import { describe, expect, it } from 'vitest';
import { detectDelimiter, parseCsv, suggestMapping, csvParser } from '../src/parsers/csv.js';
import { extractCashOperations, extractHtmlFromMhtml, parseTradeComment, xtbParser } from '../src/parsers/xtb.js';
import { detectParser } from '../src/parsers/registry.js';

/**
 * Fixture odwzorowuje strukturę realnego eksportu XTB: MHTML z zagnieżdżonymi
 * tabelami SSRS. Dane są syntetyczne, ale układ i nazewnictwo zgodne
 * z prawdziwym plikiem.
 */
function xtbFixture(rows: string): Buffer {
  const html = `<!DOCTYPE HTML><html><head><title>StatementOnline</title></head><body>
<TABLE><TR><TD><TABLE><TR><TD>Name and surname</TD><TD>Account</TD><TD>Currency</TD></TR>
<TR><TD>Jan Kowalski</TD><TD>12345678</TD><TD>PLN</TD></TR></TABLE></TD></TR>
<TR><TD><TABLE>
<TR><TD>CASH OPERATION HISTORY</TD></TR>
<TR><TD>ID</TD><TD>Type</TD><TD>Time</TD><TD>Comment</TD><TD>Symbol</TD><TD>Amount</TD></TR>
${rows}
<TR><TD></TD><TD>Total</TD><TD></TD><TD></TD><TD></TD><TD>0.75</TD></TR>
</TABLE></TD></TR></TABLE></body></html>`;

  const boundary = '----=_NextPart_TEST';
  const mhtml =
    `MIME-Version: 1.0\r\nContent-Type: multipart/related;\r\n\tboundary="${boundary}"\r\n` +
    `X-MSSQLRS-ProducerVersion: V15.0\r\n\r\n` +
    `--${boundary}\r\nContent-ID: <StatementOnline>\r\nContent-Type: text/html;\r\n\tcharset="utf-8"\r\n` +
    `Content-Transfer-Encoding: base64\r\n\r\n` +
    `${Buffer.from(html, 'utf8').toString('base64')}\r\n--${boundary}--\r\n`;

  return Buffer.from(mhtml, 'utf8');
}

const row = (id: string, type: string, time: string, comment: string, symbol: string, amount: string): string =>
  `<TR><TD>${id}</TD><TD>${type}</TD><TD>${time}</TD><TD>${comment}</TD><TD>${symbol}</TD><TD>${amount}</TD></TR>`;

describe('XTB — opis transakcji', () => {
  it('odczytuje ilość i cenę', () => {
    expect(parseTradeComment('OPEN BUY 0.5 @ 346.50')).toEqual({ quantity: '0.5', price: '346.50' });
  });

  it('bierze zrealizowaną część przy częściowym wykonaniu zlecenia', () => {
    // "0.2301/2.2301" znaczy: z całości 2.2301 zrealizowano tę partię 0.2301.
    expect(parseTradeComment('OPEN BUY 0.2301/2.2301 @ 10.485')).toEqual({
      quantity: '0.2301',
      price: '10.485',
    });
  });

  it('obsługuje zamknięcie pozycji', () => {
    expect(parseTradeComment('CLOSE BUY 1 @ 65.72')).toEqual({ quantity: '1', price: '65.72' });
  });

  it('zwraca null dla opisu bez transakcji', () => {
    expect(parseTradeComment('Transfer in operation on account with id 12345678')).toBeNull();
  });
});

describe('XTB — struktura MHTML', () => {
  it('wyciąga sekcję operacji gotówkowych z zagnieżdżonych tabel', () => {
    const buffer = xtbFixture(row('1', 'IKE Deposit', '27/09/2025 20:01:22', 'Transfer in', '', '615.00'));
    const operations = extractCashOperations(extractHtmlFromMhtml(buffer));
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ id: '1', type: 'IKE Deposit', amount: '615.00' });
  });

  it('pomija wiersz sumaryczny bez identyfikatora', async () => {
    const buffer = xtbFixture(row('1', 'IKE Deposit', '27/09/2025 20:01:22', 'Transfer in', '', '615.00'));
    const result = await xtbParser.parse(buffer);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.type).toBe('deposit');
  });
});

describe('XTB — księgowanie sprzedaży', () => {
  it('dolicza wynik z wiersza "close trade" do przychodu ze sprzedaży', async () => {
    // XTB rozbija zamknięcie pozycji na dwa wpisy: zwrot kapitału (125.96)
    // i osobno wynik (108.77). Rzeczywisty wpływ to 234.73 zł.
    const buffer = xtbFixture(
      [
        row('10', 'Stock purchase', '29/09/2025 15:31:21', 'OPEN BUY 1 @ 34.48', 'INTC.US', '-125.96'),
        row('20', 'close trade', '20/04/2026 17:51:00', 'Profit of position #123', 'INTC.US', '108.77'),
        row('21', 'Stock sale', '20/04/2026 17:51:00', 'CLOSE BUY 1 @ 65.72', 'INTC.US', '125.96'),
      ].join('\n'),
    );

    const result = await xtbParser.parse(buffer);
    const sell = result.rows.find((r) => r.type === 'sell');

    expect(sell).toBeDefined();
    expect(result.rows.some((r) => r.note?.includes('Profit of position'))).toBe(false);
    // Kurs odtworzony z pełnego przychodu: 234.73 / (1 × 65.72) ≈ 3.5717.
    expect(Number(sell!.fxRate)).toBeCloseTo(3.5717, 3);
  });

  it('rozdziela dwa równoczesne zamknięcia tego samego papieru', async () => {
    const buffer = xtbFixture(
      [
        row('30', 'close trade', '27/05/2026 13:38:44', 'Profit of position #9', 'BY6.DE', '-0.54'),
        row('31', 'Stock sale', '27/05/2026 13:38:44', 'CLOSE BUY 0.2301/2.2301 @ 9.971', 'BY6.DE', '10.21'),
        row('32', 'close trade', '27/05/2026 13:38:44', 'Profit of position #9', 'BY6.DE', '-4.70'),
        row('33', 'Stock sale', '27/05/2026 13:38:44', 'CLOSE BUY 2/2.2301 @ 9.971', 'BY6.DE', '88.72'),
      ].join('\n'),
    );

    const result = await xtbParser.parse(buffer);
    const sells = result.rows.filter((r) => r.type === 'sell');
    expect(sells).toHaveLength(2);
    // Każda sprzedaż dostaje własny wynik, a nie sumę obu.
    expect(sells.every((s) => Number(s.fxRate) > 4 && Number(s.fxRate) < 4.5)).toBe(true);
  });
});

describe('XTB — waluty i typy operacji', () => {
  it('rozpoznaje instrument złotowy po kursie równym jeden', async () => {
    const buffer = xtbFixture(
      row('40', 'Stock purchase', '29/09/2025 09:06:55', 'OPEN BUY 2 @ 72.02', 'XTB.PL', '-144.04'),
    );
    const result = await xtbParser.parse(buffer);

    expect(result.rows[0]?.currency).toBe('PLN');
    expect(result.rows[0]?.fxRate).toBeNull();
    expect(result.rows[0]?.currencyInferred).toBe(false);
  });

  it('wnioskuje walutę obcą i odtwarza kurs brokera', async () => {
    const buffer = xtbFixture(
      row('41', 'Stock purchase', '29/09/2025 09:00:30', 'OPEN BUY 0.5 @ 346.50', 'NOVOB.DK', '-100.03'),
    );
    const result = await xtbParser.parse(buffer);

    expect(result.rows[0]?.currency).toBe('DKK');
    expect(result.rows[0]?.currencyInferred).toBe(true);
    expect(Number(result.rows[0]?.fxRate)).toBeCloseTo(0.5774, 4);
  });

  it('oznacza niejednoznaczne rynki jako wymagające sprawdzenia', async () => {
    // Sufiks .UK obsługuje zarówno papiery w USD, jak i w GBP.
    const buffer = xtbFixture(
      row('42', 'Stock purchase', '29/09/2025 09:13:23', 'OPEN BUY 0.2113 @ 40.800', 'IUIT.UK', '-31.51'),
    );
    const result = await xtbParser.parse(buffer);
    expect(result.rows[0]?.issues.join(' ')).toContain('wywnioskowana');
  });

  it('mapuje dywidendę, podatek u źródła i odsetki', async () => {
    const buffer = xtbFixture(
      [
        row('50', 'DIVIDENT', '31/03/2026 11:58:02', 'NOVOB.DK DKK 7.9500/ SHR', 'NOVOB.DK', '2.26'),
        row('51', 'Withholding Tax', '31/03/2026 11:58:02', 'NOVOB.DK DKK WHT 27%', 'NOVOB.DK', '-0.61'),
        row('52', 'Free-funds Interest', '03/10/2025 14:55:44', 'Free-funds Interest 2025-09', '', '0.02'),
      ].join('\n'),
    );

    const result = await xtbParser.parse(buffer);
    expect(result.rows.map((r) => r.type)).toEqual(['dividend', 'tax', 'interest']);
    expect(result.rows[0]?.grossAmount).toBe('2.26');
    expect(result.rows[1]?.grossAmount).toBe('0.61');
  });
});

describe('CSV — parsowanie', () => {
  it('obsługuje cudzysłowy i przecinki wewnątrz pól', () => {
    const table = parseCsv('a,b\n"pierwszy, z przecinkiem","drugi ""w cudzysłowie"""');
    expect(table[1]).toEqual(['pierwszy, z przecinkiem', 'drugi "w cudzysłowie"']);
  });

  it('obsługuje nowe linie wewnątrz pola', () => {
    const table = parseCsv('a,b\n"wielo\nliniowy",x');
    expect(table).toHaveLength(2);
    expect(table[1]?.[0]).toBe('wielo\nliniowy');
  });

  it('wykrywa separator', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a\tb\tc')).toBe('\t');
    expect(detectDelimiter('a,b,c')).toBe(',');
  });

  it('pomija znacznik BOM', () => {
    expect(parseCsv('﻿data,typ\n2025-01-01,buy')[0]?.[0]).toBe('data');
  });
});

describe('CSV — kreator mapowania', () => {
  it('podpowiada mapowanie po nazwach kolumn', () => {
    const mapping = suggestMapping(['Data', 'Rodzaj transakcji', 'Ticker', 'Liczba', 'Cena', 'Prowizja']);
    expect(mapping.date).toBe('Data');
    expect(mapping.type).toBe('Rodzaj transakcji');
    expect(mapping.symbol).toBe('Ticker');
    expect(mapping.quantity).toBe('Liczba');
    expect(mapping.fee).toBe('Prowizja');
  });

  it('zostawia null dla kolumn, których nie ma', () => {
    expect(suggestMapping(['Data', 'Typ']).tax).toBeNull();
  });

  it('importuje wiersze zgodnie z mapowaniem', async () => {
    const csv = 'Data,Operacja,Symbol,Ilosc,Kurs,Waluta\n2025-03-01,Zakup,BTC,0.5,120000,PLN\n';
    const result = await csvParser.parse(Buffer.from(csv, 'utf8'));

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      tradeDate: '2025-03-01',
      type: 'buy',
      rawSymbol: 'BTC',
      quantity: '0.5',
      assetClass: 'crypto',
    });
  });

  it('pomija wiersze bez rozpoznanej daty lub operacji', async () => {
    const csv = 'Data,Operacja,Symbol\n2025-03-01,Zakup,BTC\nsuma,,\n';
    const result = await csvParser.parse(Buffer.from(csv, 'utf8'));
    expect(result.rows).toHaveLength(1);
    expect(result.notes.join(' ')).toContain('Pominięto 1');
  });
});

describe('rejestr parserów', () => {
  it('rozpoznaje wyciąg XTB po nagłówku raportu', async () => {
    const buffer = xtbFixture(row('1', 'IKE Deposit', '27/09/2025 20:01:22', 'Transfer in', '', '615.00'));
    const detected = await detectParser(buffer, 'account_statement.mhtml');

    expect(detected?.parser.id).toBe('xtb-mhtml');
    expect(detected?.confidence).toBeGreaterThan(0.9);
  });

  it('kieruje nieznany plik CSV do kreatora mapowania', async () => {
    const detected = await detectParser(Buffer.from('a,b\n1,2', 'utf8'), 'giełda-krypto.csv');
    expect(detected?.parser.id).toBe('generic-csv');
  });

  it('zwraca null dla formatu, którego nikt nie obsługuje', async () => {
    const detected = await detectParser(Buffer.from([0x00, 0x01, 0x02]), 'plik.bin');
    expect(detected).toBeNull();
  });
});
