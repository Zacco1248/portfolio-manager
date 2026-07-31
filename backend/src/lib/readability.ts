/**
 * Wyciąganie treści artykułu ze strony.
 *
 * Świadomie na wyrażeniach regularnych, bez parsera DOM — tak samo jak przy
 * kanałach RSS. Zadanie jest wąskie: wystarczy tekst do przeczytania, a nie
 * wierne odwzorowanie strony. Dokładanie zależności na jedną funkcję byłoby
 * nieproporcjonalne.
 *
 * To czytnik, a nie archiwum: treść pobieramy na żądanie i nigdzie nie
 * zapisujemy. Adres źródła zostaje widoczny, żeby dało się przejść do
 * oryginału.
 */

/** Znaczniki, których zawartość nigdy nie jest treścią artykułu. */
const NOISE_TAGS = ['script', 'style', 'noscript', 'iframe', 'svg', 'form', 'nav', 'aside', 'footer', 'header'];

/**
 * Kolejność prób: od najbardziej wiarygodnego pojemnika do najszerszego.
 *
 * Wzorce są globalne i sprawdzamy wszystkie dopasowania, a nie pierwsze.
 * Serwisy potrafią zagnieżdżać `<article>` — wewnątrz właściwego tekstu siedzą
 * kafelki „przeczytaj też", też opakowane w `<article>`. Leniwy regex kończył
 * wtedy na pierwszym domknięciu i z całego materiału zostawał sam lead.
 */
const CONTENT_PATTERNS = [
  /<article\b[^>]*>([\s\S]*?)<\/article>/gi,
  /<main\b[^>]*>([\s\S]*?)<\/main>/gi,
  /<div\b[^>]*(?:class|id)="[^"]*(?:article|content|entry|post|tresc|tekst)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
  /<body\b[^>]*>([\s\S]*?)<\/body>/gi,
];

/** Ile akapitów zawiera fragment — miara tego, czy to właściwa treść. */
function paragraphCount(fragment: string): number {
  return [...fragment.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].filter(
    (m) => (m[1] ?? '').replace(/<[^>]+>/g, ' ').trim().length >= MIN_PARAGRAPH_CHARS,
  ).length;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  oacute: 'ó',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  bdquo: '„',
  rdquo: '”',
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match);
}

/** Tytuł strony — używany, gdy tytuł z kanału RSS jest ucięty. */
export function extractTitle(html: string): string | null {
  const og = /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i.exec(html);
  if (og?.[1]) return decodeEntities(og[1]).trim();

  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return title?.[1] ? decodeEntities(title[1]).trim() : null;
}

export interface ArticleContent {
  title: string | null;
  /** Akapity w kolejności występowania. Puste, gdy nic sensownego nie zostało. */
  paragraphs: string[];
  /** Czy tekst został przycięty do limitu. */
  truncated: boolean;
  /**
   * Czy strona zasłania treść płatnym dostępem. Wtedy w HTML zostaje sam lead
   * i warto powiedzieć wprost, że to nie usterka czytnika.
   */
  paywalled: boolean;
}

/** Górny limit długości — artykuły bywają długie, a to ma być podgląd. */
const MAX_CHARS = 20_000;

/** Krótsze fragmenty to zwykle podpisy, przyciski i okruszki nawigacji. */
const MIN_PARAGRAPH_CHARS = 40;

export function extractArticle(html: string): ArticleContent {
  let working = html;
  for (const tag of NOISE_TAGS) {
    working = working.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), ' ');
  }
  working = working.replace(/<!--[\s\S]*?-->/g, ' ');

  /*
   * Spośród wszystkich dopasowań bierzemy to z największą liczbą akapitów,
   * a nie pierwsze. Przy zagnieżdżonych pojemnikach pierwsze bywa najkrótsze.
   */
  let container: string | null = null;
  let bestCount = 0;
  for (const pattern of CONTENT_PATTERNS) {
    for (const match of working.matchAll(pattern)) {
      const candidate = match[1] ?? '';
      if (candidate.length <= 200) continue;

      const count = paragraphCount(candidate);
      if (count > bestCount) {
        bestCount = count;
        container = candidate;
      }
    }
    // Znaleziony sensowny pojemnik kończy poszukiwania — kolejne wzorce są
    // coraz szersze i wciągnęłyby nawigację razem z treścią.
    if (bestCount >= 3) break;
  }

  const body = container ?? working;

  /*
   * Akapity bierzemy z `<p>`, a gdy ich nie ma — z podziału po blokach.
   * Niektóre serwisy składają tekst z samych `<div>`, więc oparcie się
   * wyłącznie na `<p>` zwracałoby dla nich pustkę. Odwrotnie też: próg
   * „co najmniej kilka `<p>`" gubiłby krótkie, dwuakapitowe notki.
   */
  const rawParagraphs = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => m[1] ?? '');
  const usableParagraphs = rawParagraphs.filter(
    (chunk) => chunk.replace(/<[^>]+>/g, ' ').trim().length >= MIN_PARAGRAPH_CHARS,
  );
  const source =
    usableParagraphs.length > 0 ? rawParagraphs : body.split(/<\/?(?:div|br|li|h[1-6])\b[^>]*>/i);

  const seen = new Set<string>();
  const paragraphs: string[] = [];
  let total = 0;
  let truncated = false;

  for (const chunk of source) {
    const text = decodeEntities(chunk.replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();

    if (text.length < MIN_PARAGRAPH_CHARS) continue;
    // Menu i stopki potrafią powtórzyć ten sam fragment kilka razy.
    if (seen.has(text)) continue;
    seen.add(text);

    if (total + text.length > MAX_CHARS) {
      truncated = true;
      break;
    }

    paragraphs.push(text);
    total += text.length;
  }

  /*
   * Znaczniki systemów płatności — obecność któregokolwiek oznacza, że serwis
   * świadomie oddał tylko fragment. Bez tego rozróżnienia krótki tekst
   * wyglądałby na błąd wyciągania.
   */
  const paywalled = /piano-(?:hard-)?paywall|gate-teaser|paywall-box|premium-gate/i.test(html);

  return { title: extractTitle(html), paragraphs, truncated, paywalled };
}
