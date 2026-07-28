import Anthropic from '@anthropic-ai/sdk';
import { AI_DISCLAIMER } from '@portfolio/shared';
import type { Importance, Sentiment } from '@portfolio/shared';
import { config } from '../config.js';
import { errorMessage } from '../lib/errors.js';
import { fetchJson } from '../lib/http-client.js';
import { createLogger } from '../lib/logger.js';
import { apiKeyFor, checkFeature, getAiSettings } from './ai-config.js';

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

let anthropicClient: Anthropic | null = null;

/**
 * Czy analiza wiadomości może zadziałać.
 *
 * Sama obecność klucza nie wystarcza — funkcja musi być jeszcze włączona
 * w ustawieniach. Domyślnie jest wyłączona, żeby żadne dane nie opuściły
 * serwera bez świadomej decyzji.
 */
export function isAiEnabled(): boolean {
  return checkFeature('news').enabled;
}

function getAnthropic(): Anthropic | null {
  const key = apiKeyFor('anthropic');
  if (!key) return null;
  anthropicClient ??= new Anthropic({ apiKey: key });
  return anthropicClient;
}

/**
 * Wywołanie modelu niezależne od dostawcy.
 *
 * OpenAI wołamy przez zwykły REST, bez dokładania kolejnej biblioteki —
 * używamy jednego endpointu i nie potrzebujemy niczego poza nim.
 */
export async function complete(system: string, user: string, maxTokens = 4096): Promise<string | null> {
  const settings = getAiSettings();

  if (settings.provider === 'openai') {
    const key = apiKeyFor('openai');
    if (!key) return null;

    const response = await fetchJson<{ choices?: { message?: { content?: string } }[] }>(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        timeoutMs: 60_000,
        retries: 1,
        body: {
          model: settings.model,
          max_completion_tokens: maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        },
      },
    );
    return response.choices?.[0]?.message?.content ?? null;
  }

  const anthropic = getAnthropic();
  if (!anthropic) return null;

  const response = await anthropic.messages.create({
    model: settings.model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });

  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
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
  if (!checkFeature('news').enabled || items.length === 0) return [];

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
    const text = await complete(SYSTEM_PROMPT, userMessage);
    if (!text) return [];
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


const NARRATIVE_PROMPT = `Jesteś asystentem, który komentuje postępy inwestora indywidualnego.

Dostajesz zagregowane liczby o portfelu. Napisz 3-4 zdania po polsku: co się udało, co warto docenić
i na co zwrócić uwagę. Ton rzeczowy i wspierający, bez euforii i bez straszenia.

Zasady:
- Nie doradzaj kupna ani sprzedaży czegokolwiek.
- Nie obiecuj przyszłych wyników. Projekcja to ekstrapolacja tempa, powiedz to wprost, jeśli o niej wspominasz.
- Nie wymyślaj liczb spoza tych, które dostałeś.
- Odpowiadasz samym tekstem, bez nagłówków i bez formatowania.`;

export interface NarrativeInput {
  valuePlnMinor: number;
  investedPlnMinor: number;
  gainPlnMinor: number;
  monthlyContributionPlnMinor: number;
  projectedIn5YearsPlnMinor: number;
  emergencyFundCoveredMonths: number | null;
}

/**
 * Komentarz do podsumowania. Do modelu trafiają wyłącznie zagregowane kwoty —
 * bez listy transakcji, nazw instrumentów i historii.
 */
export async function generateNarrative(input: NarrativeInput): Promise<string | null> {
  if (!checkFeature('insights').enabled) return null;

  const zl = (minor: number): string => (minor / 100).toFixed(2);
  const payload = [
    `wartość portfela: ${zl(input.valuePlnMinor)} zł`,
    `wpłacony kapitał: ${zl(input.investedPlnMinor)} zł`,
    `wynik: ${zl(input.gainPlnMinor)} zł`,
    `średnia miesięczna wpłata: ${zl(input.monthlyContributionPlnMinor)} zł`,
    `projekcja na 5 lat przy tym tempie: ${zl(input.projectedIn5YearsPlnMinor)} zł`,
    input.emergencyFundCoveredMonths === null
      ? 'poduszka finansowa: nieskonfigurowana'
      : `poduszka finansowa pokrywa ${input.emergencyFundCoveredMonths} miesięcy wydatków`,
  ].join('\n');

  try {
    return await complete(NARRATIVE_PROMPT, payload, 600);
  } catch (err) {
    log.warn(`Komentarz AI nieudany: ${errorMessage(err)}`);
    return null;
  }
}
