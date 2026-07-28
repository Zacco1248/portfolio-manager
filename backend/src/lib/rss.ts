/**
 * Czytnik kanałów RSS i Atom.
 *
 * Świadomie na wyrażeniach regularnych, a nie na parserze HTML: `<link>` jest
 * w HTML-u elementem pustym, więc parser HTML-a gubi treść linku w kanale RSS
 * i każdy wpis wypada na sprawdzeniu adresu. Kanały mają prostą, płaską
 * strukturę, więc pełny parser XML byłby tu przerostem formy.
 */

export interface FeedEntry {
  title: string;
  url: string;
  publishedAt: string;
  summary: string | null;
}

/** Zdejmuje opakowanie CDATA i rozwiązuje encje. */
function decodeText(raw: string | undefined): string {
  if (!raw) return '';
  const withoutCdata = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return withoutCdata
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Zawartość pierwszego wystąpienia znacznika w bloku wpisu. */
function tagContent(block: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return match?.[1];
}

/**
 * Adres wpisu. RSS trzyma go w treści `<link>`, Atom w atrybucie `href`
 * — w Atomie bywa kilka linków, więc bierzemy ten z `rel="alternate"`
 * albo pierwszy bez `rel`.
 */
function extractLink(block: string): string {
  const rssLink = decodeText(tagContent(block, 'link'));
  if (rssLink.startsWith('http')) return rssLink;

  const alternate = /<link\b[^>]*rel="alternate"[^>]*href="([^"]+)"/i.exec(block);
  if (alternate?.[1]) return decodeText(alternate[1]);

  const anyHref = /<link\b[^>]*href="([^"]+)"/i.exec(block);
  if (anyHref?.[1]) return decodeText(anyHref[1]);

  // Część kanałów podaje adres kanoniczny zamiast linku.
  const guid = decodeText(tagContent(block, 'guid'));
  return guid.startsWith('http') ? guid : '';
}

function extractDate(block: string): string {
  const raw =
    tagContent(block, 'pubDate') ??
    tagContent(block, 'published') ??
    tagContent(block, 'updated') ??
    tagContent(block, 'dc:date');

  const text = decodeText(raw);
  if (!text) return new Date().toISOString();

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

export function parseFeed(xml: string): FeedEntry[] {
  const entries: FeedEntry[] = [];

  // RSS używa <item>, Atom <entry>. Obsługujemy oba w jednym przebiegu.
  const blocks = [
    ...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi),
    ...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi),
  ];

  for (const match of blocks) {
    const block = match[1]!;
    const title = decodeText(tagContent(block, 'title'));
    const url = extractLink(block);
    if (!title || !url) continue;

    const summary = decodeText(
      tagContent(block, 'description') ?? tagContent(block, 'summary') ?? tagContent(block, 'content'),
    );

    entries.push({
      title,
      url,
      publishedAt: extractDate(block),
      summary: summary || null,
    });
  }

  return entries;
}
