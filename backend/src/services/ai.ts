import Anthropic from '@anthropic-ai/sdk';
import { AI_DISCLAIMER } from '@portfolio/shared';
import type { Importance, Sentiment } from '@portfolio/shared';
import { config } from '../config.js';
import { errorMessage } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('ai');

/**
 * Analiza wiadomości przez Anthropic API.
 *
 * Cała integracja jest opcjonalna — brak `ANTHROPIC_API_KEY` oznacza, że
 * funkcje zwracają pustą listę, a moduł newsów pokazuje surowe nagłówki.
 *
 * Model dostaje wyłącznie treść wiadomości. Nie przekazujemy mu stanu
 * portfela ani kwot: zadaniem jest streszczenie i ocena wydźwięku informacji,
 * a nie doradzanie przy konkretnych pozycjach.
 */

let client: Anthropic | null = null;

export function isAiEnabled(): boolean {
  return config.ai.enabled;
}

function getClient(): Anthropic | null {
  if (!config.ai.enabled || !config.ai.apiKey) return null;
  client ??= new Anthropic({ apiKey: config.ai.apiKey });
  return client;
}

export interface NewsForAnalysis {
  id: number;
  title: string;
  summary: string | null;
  instrumentName: string | null;
}

export interface NewsAnalysis {
  id: number;
  summaryPl: string;
  sentiment: Sentiment;
  importance: Importance;
  signal: { hold: string[]; reduce: string[]; rationale: string };
}

const SYSTEM_PROMPT = `Jesteś asystentem analizującym wiadomości giełdowe dla inwestora indywidualnego z Polski.

Dla każdej wiadomości podaj:
- streszczenie po polsku w 2-3 zdaniach, konkretne i bez lania wody,
- wydźwięk dla notowań spółki: positive, neutral albo negative,
- wagę: "signal" jeśli informacja może realnie wpłynąć na wycenę (wyniki, przejęcia, zmiany zarządu, regulacje, duże kontrakty), albo "noise" dla materiałów marketingowych, powtórzeń i ogólnych komentarzy rynkowych,
- argumenty "za trzymaniem" i "za redukcją" pozycji, wynikające WYŁĄCZNIE z treści tej wiadomości.

Zasady:
- Nie formułuj rekomendacji kupna ani sprzedaży. Podajesz argumenty, nie zalecenia.
- Nie zmyślaj faktów spoza treści wiadomości. Jeśli informacja jest zbyt uboga, napisz to wprost i oznacz jako "noise".
- Jeśli lista argumentów byłaby pusta, zwróć pustą tablicę zamiast wymyślać.

Odpowiadasz wyłącznie poprawnym JSON-em, bez komentarzy i bez bloków kodu.`;

interface RawAnalysis {
  id: number;
  summaryPl?: string;
  sentiment?: string;
  importance?: string;
  hold?: string[];
  reduce?: string[];
  rationale?: string;
}

/**
 * Analizuje partię wiadomości jednym wywołaniem — koszt rośnie liniowo
 * z liczbą tokenów, a jedno zapytanie na kilkanaście newsów jest wyraźnie
 * tańsze niż kilkanaście osobnych.
 */
export async function analyzeNewsBatch(items: NewsForAnalysis[]): Promise<NewsAnalysis[]> {
  const anthropic = getClient();
  if (!anthropic || items.length === 0) return [];

  const payload = items.map((item) => ({
    id: item.id,
    spolka: item.instrumentName ?? 'nieznana',
    tytul: item.title,
    tresc: item.summary?.slice(0, 1200) ?? '',
  }));

  const userMessage = `Przeanalizuj poniższe wiadomości. Zwróć tablicę JSON, po jednym obiekcie na wiadomość, w formacie:
[{"id": <liczba>, "summaryPl": "...", "sentiment": "positive|neutral|negative", "importance": "signal|noise", "hold": ["..."], "reduce": ["..."], "rationale": "..."}]

Wiadomości:
${JSON.stringify(payload, null, 1)}`;

  try {
    const response = await anthropic.messages.create({
      model: config.ai.model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    return parseAnalysisResponse(text, items);
  } catch (err) {
    // Awaria API nie może zatrzymać crona ani zepsuć widoku newsów —
    // wiadomości zostają bez analizy i zostaną spróbowane ponownie.
    log.warn(`Analiza AI nieudana: ${errorMessage(err)}`);
    return [];
  }
}

/** Wyciąga JSON z odpowiedzi, tolerując opakowanie w blok kodu. */
export function parseAnalysisResponse(text: string, items: NewsForAnalysis[]): NewsAnalysis[] {
  const known = new Set(items.map((i) => i.id));

  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    log.warn('Odpowiedź AI nie zawiera tablicy JSON — pomijam partię');
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch (err) {
    log.warn(`Nie umiem sparsować odpowiedzi AI: ${errorMessage(err)}`);
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const out: NewsAnalysis[] = [];
  for (const entry of parsed as RawAnalysis[]) {
    // Model bywa kreatywny z identyfikatorami — przyjmujemy tylko te,
    // o które faktycznie pytaliśmy.
    if (typeof entry?.id !== 'number' || !known.has(entry.id)) continue;

    out.push({
      id: entry.id,
      summaryPl: typeof entry.summaryPl === 'string' ? entry.summaryPl.trim() : '',
      sentiment: normalizeSentiment(entry.sentiment),
      importance: entry.importance === 'signal' ? 'signal' : 'noise',
      signal: {
        hold: Array.isArray(entry.hold) ? entry.hold.filter((s): s is string => typeof s === 'string') : [],
        reduce: Array.isArray(entry.reduce) ? entry.reduce.filter((s): s is string => typeof s === 'string') : [],
        rationale: typeof entry.rationale === 'string' ? entry.rationale.trim() : '',
      },
    });
  }

  return out;
}

function normalizeSentiment(value: unknown): Sentiment {
  switch (String(value).toLowerCase()) {
    case 'positive':
    case 'pozytywny':
      return 'positive';
    case 'negative':
    case 'negatywny':
      return 'negative';
    default:
      return 'neutral';
  }
}

export const aiDisclaimer = AI_DISCLAIMER;
