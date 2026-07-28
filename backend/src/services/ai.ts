import Anthropic from '@anthropic-ai/sdk';
import { AI_DISCLAIMER } from '@portfolio/shared';
import type { Importance, Sentiment } from '@portfolio/shared';
import { config } from '../config.js';
import { errorMessage } from '../lib/errors.js';
import { fetchJson } from '../lib/http-client.js';
import { createLogger } from '../lib/logger.js';
import type { AiProvider } from './ai-config.js';
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
/** Zapas tokenów na rozumowanie modeli myślących u OpenAI. */
const REASONING_HEADROOM = 3000;

export async function complete(system: string, user: string, maxTokens = 4096): Promise<string | null> {
  return (await completeWithMeta(system, user, maxTokens)).text;
}

export interface CompletionMeta {
  text: string | null;
  /**
   * Powód zakończenia odpowiedzi. Interesuje nas głównie 'length': modele
   * rozumujące potrafią zużyć cały budżet na rozumowanie i zwrócić pustą treść,
   * co bez tej informacji wygląda identycznie jak awaria dostawcy.
   */
  finishReason: string | null;
  /** Tokeny zużyte na rozumowanie, jeśli dostawca je raportuje. */
  reasoningTokens: number | null;
}

export async function completeWithMeta(system: string, user: string, maxTokens = 4096): Promise<CompletionMeta> {
  const settings = getAiSettings();
  const empty: CompletionMeta = { text: null, finishReason: null, reasoningTokens: null };

  if (settings.provider === 'openai') {
    const key = apiKeyFor('openai');
    if (!key) return empty;

    const response = await fetchJson<{
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
    }>('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      timeoutMs: 60_000,
      retries: 1,
      body: {
        model: settings.model,
        /*
         * Zapas na rozumowanie. U OpenAI `max_completion_tokens` obejmuje też
         * tokeny rozumowania, których nie widać w odpowiedzi — bez zapasu model
         * myślący zjada budżet przeznaczony na treść i zwraca pustkę.
         * Zapas kosztuje tylko wtedy, gdy zostanie zużyty.
         */
        max_completion_tokens: maxTokens + REASONING_HEADROOM,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      },
    });

    const choice = response.choices?.[0];
    return {
      text: choice?.message?.content ?? null,
      finishReason: choice?.finish_reason ?? null,
      reasoningTokens: response.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    };
  }

  const anthropic = getAnthropic();
  if (!anthropic) return empty;

  const response = await anthropic.messages.create({
    model: settings.model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });

  return {
    text: response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n'),
    finishReason: response.stop_reason ?? null,
    reasoningTokens: null,
  };
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


/**
 * Budżet tokenów testu. Musi pomieścić rozumowanie modelu myślącego, inaczej
 * test zgłasza awarię tam, gdzie połączenie jest całkiem sprawne.
 */
const TEST_TOKEN_BUDGET = 2000;

export interface AiConnectionTest {
  ok: boolean;
  provider: AiProvider;
  model: string;
  /** Czas odpowiedzi w milisekundach — pomaga odróżnić awarię od powolnego modelu. */
  latencyMs: number | null;
  message: string;
  /** Odpowiedź modelu, przycięta. Dowód, że połączenie faktycznie zadziałało. */
  reply: string | null;
}

/**
 * Sprawdzenie połączenia z dostawcą modelu.
 *
 * Świadomie omija przełączniki poszczególnych funkcji: to jawne działanie
 * użytkownika w ustawieniach, a nie automatyczne wywołanie w tle. Wysyłamy
 * wyłącznie stałe zdanie testowe — nic z portfela.
 */
export async function testAiConnection(): Promise<AiConnectionTest> {
  const settings = getAiSettings();
  const base = { provider: settings.provider, model: settings.model };

  if (!apiKeyFor(settings.provider)) {
    const variable = settings.provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
    return {
      ...base,
      ok: false,
      latencyMs: null,
      reply: null,
      message: `Brak ${variable} w pliku .env. Po dopisaniu klucza zrestartuj kontener — .env czytany jest przy starcie.`,
    };
  }

  const started = Date.now();

  try {
    /*
     * Budżet celowo hojny jak na jedno słowo. Modele rozumujące (GPT-5, o-serie)
     * najpierw myślą, a dopiero potem piszą — przy ciasnym limicie cały budżet
     * schodzi na rozumowanie i wraca pusta treść z finish_reason „length".
     */
    const result = await completeWithMeta(
      'Odpowiadasz jednym słowem, bez interpunkcji i bez wyjaśnień.',
      'Napisz: dziala',
      TEST_TOKEN_BUDGET,
    );
    const latencyMs = Date.now() - started;
    const reply = result.text;

    if (!reply || reply.trim().length === 0) {
      const truncated = result.finishReason === 'length' || result.finishReason === 'max_tokens';
      return {
        ...base,
        ok: false,
        latencyMs,
        reply: null,
        message: truncated
          ? `Połączenie z dostawcą działa i klucz jest poprawny, ale model zużył cały budżet ${TEST_TOKEN_BUDGET} tokenów` +
            `${result.reasoningTokens ? ` (w tym ${result.reasoningTokens} na rozumowanie)` : ''} i nie zdążył nic napisać. ` +
            'To typowe dla modeli rozumujących — wybierz lżejszy model albo zignoruj ten wynik, bo pozostałe funkcje mają dużo większe limity.'
          : 'Dostawca odpowiedział, ale bez treści. Sprawdź, czy wybrany model istnieje i jest dostępny dla Twojego klucza.',
      };
    }

    return {
      ...base,
      ok: true,
      latencyMs,
      reply: reply.trim().slice(0, 120),
      message: `Połączenie działa. Model odpowiedział w ${(latencyMs / 1000).toFixed(1)} s.`,
    };
  } catch (err) {
    return {
      ...base,
      ok: false,
      latencyMs: Date.now() - started,
      reply: null,
      message: explainAiError(errorMessage(err), settings.provider),
    };
  }
}

/**
 * Tłumaczenie błędu dostawcy na wskazówkę.
 *
 * Surowy komunikat typu „401 Unauthorized" nie mówi użytkownikowi, co zrobić,
 * a przyczyny są policzalne i za każdym razem te same.
 */
export function explainAiError(raw: string, provider: AiProvider): string {
  const text = raw.toLowerCase();
  const variable = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';

  if (text.includes('401') || text.includes('unauthorized') || text.includes('invalid_api_key') || text.includes('authentication')) {
    return `Klucz odrzucony przez dostawcę. Sprawdź ${variable} w .env — czy nie ma spacji, cudzysłowów ani ucięcia na końcu.`;
  }
  if (text.includes('404') || text.includes('model_not_found') || text.includes('does not exist')) {
    return 'Dostawca nie zna tego modelu. Wybierz inny z listy albo popraw wpisany identyfikator.';
  }
  if (text.includes('429') || text.includes('rate limit') || text.includes('quota')) {
    return 'Przekroczony limit zapytań albo wyczerpane środki na koncie u dostawcy. Sprawdź limity i saldo.';
  }
  if (text.includes('credit') || text.includes('billing') || text.includes('payment')) {
    return 'Konto u dostawcy nie ma środków albo brakuje danych rozliczeniowych.';
  }
  if (text.includes('timeout') || text.includes('etimedout') || text.includes('abort')) {
    return 'Przekroczono czas oczekiwania. Serwer może nie mieć wyjścia do internetu albo dostawca chwilowo nie odpowiada.';
  }
  if (text.includes('enotfound') || text.includes('econnrefused') || text.includes('getaddrinfo')) {
    return 'Nie udało się nawiązać połączenia. Sprawdź, czy serwer ma dostęp do internetu i czy DNS działa.';
  }

  return `Nieoczekiwany błąd dostawcy: ${raw}`;
}
