import { describe, expect, it } from 'vitest';
import { extractArticle, extractTitle } from '../src/lib/readability.js';

/**
 * Czytnik artykułów: wyciąga sam tekst ze strony, żeby dało się ją przeczytać
 * bez opuszczania aplikacji.
 *
 * Testy opisują reguły odsiewania, bo to one decydują, czy podgląd jest
 * użyteczny: menu, stopka i skrypty wyglądają w HTML tak samo jak treść.
 */

const page = (body: string, head = ''): string =>
  `<!doctype html><html><head><title>Tytuł strony</title>${head}</head><body>${body}</body></html>`;

describe('wyciąganie treści artykułu', () => {
  it('bierze akapity z sekcji article', () => {
    const html = page(`
      <nav><a href="/">Strona główna</a></nav>
      <article>
        <p>Spółka opublikowała wyniki za drugi kwartał, które okazały się wyższe od oczekiwań rynku.</p>
        <p>Przychody wzrosły o dwanaście procent rok do roku, a marża operacyjna poprawiła się o dwa punkty.</p>
      </article>
      <footer>Wszelkie prawa zastrzeżone</footer>
    `);

    const article = extractArticle(html);

    expect(article.paragraphs).toHaveLength(2);
    expect(article.paragraphs[0]).toContain('wyniki za drugi kwartał');
    expect(article.paragraphs.join(' ')).not.toContain('Wszelkie prawa zastrzeżone');
  });

  it('usuwa skrypty i style razem z ich zawartością', () => {
    const html = page(`
      <article>
        <script>var dataLayer = ['to nie jest treść artykułu do przeczytania'];</script>
        <style>.banner { display: none; content: "też nie jest treścią artykułu"; }</style>
        <p>To jest właściwa treść artykułu, wystarczająco długa, żeby przejść przez próg długości.</p>
      </article>
    `);

    const article = extractArticle(html);

    expect(article.paragraphs).toHaveLength(1);
    expect(article.paragraphs[0]).toContain('właściwa treść');
    expect(article.paragraphs.join(' ')).not.toContain('dataLayer');
  });

  it('pomija krótkie fragmenty — podpisy i okruszki nawigacji', () => {
    const html = page(`
      <article>
        <p>Gospodarka</p>
        <p>fot. PAP</p>
        <p>Rada Polityki Pieniężnej pozostawiła stopy procentowe bez zmian, co było zgodne z oczekiwaniami.</p>
      </article>
    `);

    const article = extractArticle(html);

    expect(article.paragraphs).toHaveLength(1);
    expect(article.paragraphs[0]).toContain('Rada Polityki Pieniężnej');
  });

  it('odsiewa powtórzenia — menu bywa wstawione kilka razy', () => {
    const powtorka = '<p>Ten sam blok tekstu powtórzony w nagłówku i w stopce strony serwisu.</p>';
    const html = page(`<article>${powtorka}${powtorka}<p>Właściwa treść artykułu o wynikach spółki za kwartał.</p></article>`);

    const article = extractArticle(html);

    expect(article.paragraphs).toHaveLength(2);
  });

  it('radzi sobie ze stroną złożoną z samych divów', () => {
    // Część serwisów nie używa `<p>` w ogóle — oparcie się tylko na nim
    // dawałoby dla nich pustą treść.
    const html = page(`
      <main>
        <div>Kurs akcji spółki wzrósł o osiem procent po publikacji raportu okresowego.</div>
        <div>Analitycy zwracają uwagę na poprawę rentowności w segmencie usług cyfrowych.</div>
      </main>
    `);

    const article = extractArticle(html);

    expect(article.paragraphs.length).toBeGreaterThanOrEqual(2);
    expect(article.paragraphs[0]).toContain('wzrósł o osiem procent');
  });

  it('dekoduje encje i polskie znaki', () => {
    const html = page(
      '<article><p>Zysk netto wyni&oacute;sł 12 mln zł &mdash; to wzrost o 5%, powy&#380;ej prognoz analityk&oacute;w.</p></article>',
    );

    const article = extractArticle(html);

    expect(article.paragraphs[0]).toContain('wyniósł');
    expect(article.paragraphs[0]).toContain('—');
    expect(article.paragraphs[0]).toContain('powyżej');
  });

  it('zwraca pustą listę, gdy nie ma czego czytać', () => {
    // Strona za zgodą na cookies albo wymagająca przeglądarki — wtedy interfejs
    // ma powiedzieć wprost, że się nie udało, zamiast pokazywać śmieci.
    const article = extractArticle(page('<div>Włącz JavaScript</div>'));
    expect(article.paragraphs).toHaveLength(0);
  });

  it('woli tytuł z og:title niż z tagu title', () => {
    const html = page('<article><p>Treść</p></article>', '<meta property="og:title" content="Pełny tytuł artykułu">');
    expect(extractTitle(html)).toBe('Pełny tytuł artykułu');
  });

  it('przycina bardzo długi tekst i sygnalizuje to', () => {
    // Akapity muszą się różnić, inaczej odsieje je deduplikacja i test
    // mierzyłby coś innego, niż zamierzono.
    const long = Array.from(
      { length: 30 },
      (_, i) => `<p>Akapit numer ${i} o wynikach spółki. ${'Dalszy ciąg zdania o rentowności segmentu. '.repeat(30)}</p>`,
    ).join('');
    const article = extractArticle(page(`<article>${long}</article>`));

    expect(article.truncated).toBe(true);
    expect(article.paragraphs.join('').length).toBeLessThanOrEqual(20_000);
  });
});
