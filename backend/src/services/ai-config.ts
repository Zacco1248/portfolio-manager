import type { AiUnavailable, AiUnavailableKind } from '@portfolio/shared';
import { config } from '../config.js';
import { getSetting, setSetting } from './settings.js';

/**
 * Konfiguracja funkcji opartych o model językowy.
 *
 * Dwie zasady, którym podlega cały moduł:
 *
 *  1. **Domyślnie nic nie wychodzi na zewnątrz.** Każda funkcja korzystająca
 *     z modelu jest osobnym przełącznikiem, wyłączonym dopóki użytkownik go
 *     świadomie nie włączy. Obecność klucza w `.env` nie wystarcza.
 *  2. **Widać, co dokładnie jest wysyłane.** Każda funkcja deklaruje zakres
 *     danych, żeby decyzja o jej włączeniu była podejmowana z pełną wiedzą,
 *     a nie na podstawie samej nazwy.
 */

export const AI_PROVIDERS = ['anthropic', 'openai'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const AI_FEATURES = [
  'news',
  'insights',
  'sessionSummary',
  'quickQuestion',
  'analystConsensus',
  'rebalanceHints',
  'monthlySummary',
  'priceMoves',
  'purchaseCheck',
  'documentSummary',
  'taxAssistant',
  'importMapping',
  'portfolioFit',
] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

export interface AiFeatureInfo {
  key: AiFeature;
  label: string;
  /** Co konkretnie trafia do dostawcy modelu. */
  dataSent: string;
  description: string;
}

export const AI_FEATURE_INFO: Record<AiFeature, AiFeatureInfo> = {
  analystConsensus: {
    key: 'analystConsensus',
    label: 'Konsensus analityków',
    dataSent: 'Wyłącznie symbol spółki, wysyłany do Yahoo Finance. Żadne dane portfela nie opuszczają serwera.',
    description:
      'Pobiera prawdziwe ceny docelowe i rozkład zaleceń analityków z Yahoo Finance — także dla spółek ' +
      'zagranicznych, dla których odczyt z polskich nagłówków prasowych nie działa. Korzysta z ' +
      'nieudokumentowanego mechanizmu, więc przy zmianie po stronie Yahoo wraca do odczytu z nagłówków.',
  },
  quickQuestion: {
    key: 'quickQuestion',
    label: 'Szybkie pytanie',
    dataSent:
      'Treść pytania oraz skrót portfela: symbole, nazwy, udziały, wyniki procentowe, klasy aktywów, ' +
      'sektory i regiony. Bez kwot pozycji, bez salda i bez historii transakcji.',
    description:
      'Pytanie własnymi słowami o portfel — na przykład o skutki zamiany jednej pozycji na inną. ' +
      'Model odpowiada wyłącznie na podstawie struktury portfela i nie wydaje zaleceń kupna ani sprzedaży.',
  },
  sessionSummary: {
    key: 'sessionSummary',
    label: 'Podsumowanie sesji',
    dataSent:
      'Symbole i nazwy spółek z portfela, ich zmiany dzienne, udziały w portfelu oraz tytuły wiadomości ' +
      'z ostatniej doby. Bez kwot pozycji i bez salda.',
    description:
      'Jednym akapitem opisuje, co działo się w ostatniej dobie na spółkach z portfela — kto najbardziej ' +
      'się ruszył i czy stoją za tym jakieś wiadomości.',
  },
  news: {
    key: 'news',
    label: 'Streszczenia wiadomości',
    dataSent: 'Tytuł i zajawka wiadomości oraz nazwa spółki. Bez kwot, bez stanu portfela.',
    description:
      'Streszcza newsy po polsku, ocenia wydźwięk i istotność, wypisuje argumenty za trzymaniem i za redukcją.',
  },
  insights: {
    key: 'insights',
    label: 'Komentarz do podsumowania',
    dataSent:
      'Zagregowane liczby: wartość portfela, wpłacony kapitał, wynik, średnia miesięczna wpłata. ' +
      'Bez listy transakcji i bez nazw instrumentów.',
    description: 'Ubiera wyliczone podsumowanie w kilka zdań komentarza. Same liczby powstają lokalnie.',
  },
  rebalanceHints: {
    key: 'rebalanceHints',
    label: 'Wskazówki do rebalansu',
    dataSent: 'Klasy aktywów, ich udziały procentowe i cele. Bez kwot i bez nazw instrumentów.',
    description: 'Komentuje odchylenia od alokacji docelowej. Nie proponuje konkretnych transakcji.',
  },
  monthlySummary: {
    key: 'monthlySummary',
    label: 'Podsumowanie miesiąca',
    dataSent:
      'Zmiana wartości portfela, kwota dopłat, liczba transakcji, dywidendy oraz symbole i procentowe ' +
      'zmiany kursów największych ruchów. Bez listy transakcji i bez wielkości pozycji.',
    description:
      'Opisuje zamknięty miesiąc w kilku zdaniach: co się zmieniło, skąd wynik i na co zwrócić uwagę dalej.',
  },
  priceMoves: {
    key: 'priceMoves',
    label: 'Wyjaśnianie ruchów cen',
    dataSent:
      'Nazwa instrumentu, procentowa zmiana kursu z dwóch tygodni i nagłówki wiadomości z tego okresu. ' +
      'Bez wielkości pozycji i bez kwot.',
    description:
      'Zestawia ruch kursu z wiadomościami i rozróżnia zbieżność w czasie od przyczyny. Nie prognozuje kierunku.',
  },
  purchaseCheck: {
    key: 'purchaseCheck',
    label: 'Kontrola przed zakupem',
    dataSent:
      'Symbol rozważanego instrumentu, kwota zakupu, wartość portfela oraz udziały klasy aktywów, ' +
      'sektora i regionu przed zakupem i po nim.',
    description:
      'Pokazuje, co planowany zakup zrobi ze strukturą portfela. Nie mówi „kup" ani „nie kupuj".',
  },
  documentSummary: {
    key: 'documentSummary',
    label: 'Streszczanie dokumentów',
    dataSent: 'Wyłącznie tekst, który sam wkleisz. Nic z Twojego portfela.',
    description:
      'Streszcza po polsku raport okresowy, komunikat bieżący albo prospekt funduszu — z liczbami, ' +
      'zmianami i ryzykami wskazanymi przez samą spółkę.',
  },
  taxAssistant: {
    key: 'taxAssistant',
    label: 'Asystent podatkowy',
    dataSent:
      'Zagregowane kwoty z Twojego zestawienia PIT-38 za wybrany rok: dochód, podatek, dywidendy ' +
      'i nazwy portfeli zwolnionych. Bez listy transakcji.',
    description: 'Odpowiada na pytania o Twoje konkretne zestawienie i tłumaczy, skąd biorą się kwoty.',
  },
  portfolioFit: {
    key: 'portfolioFit',
    label: 'Dopasowanie do portfela',
    dataSent:
      'Dane rynkowe waloru (zmiany kursu, wskaźniki, konsensus rekomendacji, nagłówki) oraz struktura ' +
      'Twojego portfela w procentach: sektory, regiony, luki wobec celu i udział tego waloru. Bez kwot.',
    description:
      'Ocenia, jaką rolę walor mógłby pełnić w Twoim portfelu i co pogarsza. Nie mówi „kup" ani „nie kupuj".',
  },
  importMapping: {
    key: 'importMapping',
    label: 'Rozpoznawanie formatu importu',
    dataSent: 'Nagłówki kolumn i do pięciu przykładowych wierszy z importowanego pliku.',
    description:
      'Podpowiada mapowanie kolumn nieznanego pliku CSV lub XLSX, żeby nie trzeba było dopisywać parsera.',
  },
};

/** Modele sugerowane w interfejsie. Można wpisać dowolny inny identyfikator. */
export const SUGGESTED_MODELS: Record<AiProvider, { id: string; label: string; hint: string }[]> = {
  anthropic: [
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', hint: 'najtańszy, wystarczający do streszczeń' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', hint: 'lepsza jakość, wyższy koszt' },
    { id: 'claude-opus-5', label: 'Claude Opus 5', hint: 'najmocniejszy, najdroższy' },
  ],
  openai: [
    { id: 'gpt-5-mini', label: 'GPT-5 mini', hint: 'tani wariant do streszczeń' },
    { id: 'gpt-5', label: 'GPT-5', hint: 'lepsza jakość, wyższy koszt' },
    { id: 'gpt-5-codex', label: 'GPT-5 Codex', hint: 'wariant nastawiony na kod' },
  ],
};

export interface AiSettings {
  provider: AiProvider;
  model: string;
  /** Które funkcje użytkownik świadomie włączył. */
  features: Record<AiFeature, boolean>;
  /** Dostawca wskazany w ustawieniach — bywa inny niż faktycznie użyty. */
  chosenProvider?: AiProvider;
  /** Czy sięgnęliśmy po drugiego dostawcę, bo wybrany nie ma klucza. */
  usingFallbackProvider?: boolean;
}

const DEFAULT_FEATURES: Record<AiFeature, boolean> = {
  news: false,
  insights: false,
  sessionSummary: false,
  quickQuestion: false,
  analystConsensus: false,
  rebalanceHints: false,
  monthlySummary: false,
  priceMoves: false,
  purchaseCheck: false,
  documentSummary: false,
  taxAssistant: false,
  importMapping: false,
  portfolioFit: false,
};

export function getAiSettings(): AiSettings {
  const chosen = getSetting<AiProvider>('aiProvider', 'anthropic');
  const stored = getSetting<Partial<Record<AiFeature, boolean>>>('aiFeatures', {});

  /*
   * Dostawca wybrany w ustawieniach obowiązuje tylko wtedy, gdy da się z niego
   * skorzystać. Domyślną wartością jest Anthropic, więc ktoś, kto wpisał sam
   * klucz OpenAI, dostawał „brak klucza Anthropic" mimo posiadania działającego
   * klucza — sensowniej użyć tego, który jest, niż odmówić działania.
   */
  /*
   * Zejście na drugiego dostawcę ma sens tylko wtedy, gdy on faktycznie ma
   * klucz. Wcześniej warunek nie sprawdzał tego drugiego członu, więc przy
   * pustej konfiguracji (żadnego klucza) komunikat mówił „brak klucza OpenAI"
   * komuś, kto w ustawieniach wybrał Anthropic — i kierował do nie tego pola.
   */
  const other = OTHER_PROVIDER[chosen];
  const provider = apiKeyFor(chosen) ? chosen : other && apiKeyFor(other) ? other : chosen;
  const switched = provider !== chosen;

  return {
    provider,
    // Identyfikatory modeli nie są przenośne między dostawcami, więc po zmianie
    // dostawcy zapisany model przestaje pasować i bierzemy domyślny.
    model: switched ? defaultModelFor(provider) : getSetting<string>('aiModel', defaultModelFor(provider)),
    features: { ...DEFAULT_FEATURES, ...stored },
    chosenProvider: chosen,
    usingFallbackProvider: switched,
  };
}

/** Drugi z obsługiwanych dostawców — do zejścia, gdy wybrany nie ma klucza. */
const OTHER_PROVIDER: Record<AiProvider, AiProvider> = {
  anthropic: 'openai',
  openai: 'anthropic',
};

export function defaultModelFor(provider: AiProvider): string {
  return provider === 'openai' ? config.ai.openAiModel : config.ai.model;
}

export interface AiSettingsPatch {
  provider?: AiProvider;
  model?: string;
  /** Częściowa zmiana zgód — pomijamy funkcje, których użytkownik nie dotknął. */
  features?: Partial<Record<AiFeature, boolean>>;
}

export function updateAiSettings(patch: AiSettingsPatch): AiSettings {
  if (patch.provider) {
    setSetting('aiProvider', patch.provider);
    // Zmiana dostawcy unieważnia model — identyfikatory nie są przenośne.
    if (!patch.model) setSetting('aiModel', defaultModelFor(patch.provider));
  }
  if (patch.model) setSetting('aiModel', patch.model);
  if (patch.features) {
    setSetting('aiFeatures', { ...getAiSettings().features, ...patch.features });
  }
  return getAiSettings();
}

/** Klucze zapisane z poziomu ustawień. Nigdy nie opuszczają serwera w całości. */
const KEY_SETTING: Record<AiProvider, string> = {
  anthropic: 'anthropicApiKey',
  openai: 'openAiApiKey',
};

/**
 * Klucz dla wskazanego dostawcy.
 *
 * Ustawienia mają pierwszeństwo przed `.env` — tak samo jak model i dostawca.
 * Plik `.env` czytany jest raz przy starcie procesu, więc wpisanie tam klucza
 * wymagało restartu; klucz z ustawień działa od razu.
 */
export function apiKeyFor(provider: AiProvider): string | null {
  const stored = getSetting<string | null>(KEY_SETTING[provider], null);
  if (stored && stored.trim()) return stored.trim();

  return provider === 'openai' ? (config.ai.openAiKey ?? null) : (config.ai.apiKey ?? null);
}

/** Skąd pochodzi aktualnie używany klucz — do pokazania w ustawieniach. */
export function apiKeySource(provider: AiProvider): 'settings' | 'env' | null {
  const stored = getSetting<string | null>(KEY_SETTING[provider], null);
  if (stored && stored.trim()) return 'settings';
  const fromEnv = provider === 'openai' ? config.ai.openAiKey : config.ai.apiKey;
  return fromEnv ? 'env' : null;
}

/**
 * Zapisuje albo czyści klucz dostawcy.
 *
 * Pusta wartość usuwa wpis z ustawień i przywraca ewentualny klucz z `.env` —
 * dzięki temu da się wycofać zmianę bez grzebania w bazie.
 */
export function setApiKey(provider: AiProvider, key: string | null): void {
  setSetting(KEY_SETTING[provider], key && key.trim() ? key.trim() : null);
  // Klient dostawcy trzyma klucz w domknięciu, więc bez zrzucenia go
  // pierwsze zapytanie po zmianie poleciałoby na starym.
  resetAiClients();
}

/**
 * Maska klucza do pokazania w interfejsie: początek, koniec i nic pomiędzy.
 * Wystarcza, żeby rozpoznać, który klucz jest wpisany, i nie ujawnia go.
 */
export function maskApiKey(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 12) return `${key.slice(0, 3)}…`;
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

/** Ustawiane przez `ai.ts` — pozwala zrzucić zapamiętanego klienta po zmianie klucza. */
let resetAiClients: () => void = () => undefined;

export function onApiKeyChange(reset: () => void): void {
  resetAiClients = reset;
}

export interface AiAvailability {
  /** Czy dana funkcja może teraz zadziałać: włączona i z dostępnym kluczem. */
  enabled: boolean;
  reason: string | null;
  /**
   * Ten sam powód w postaci rozpoznawalnej dla interfejsu.
   *
   * `reason` zostaje jako gotowe zdanie, bo używa go już kilka miejsc, ale samo
   * zdanie nie pozwala odróżnić braku klucza od wyłączonej funkcji — a to
   * decyduje, czy pokazać link do ustawień, czy przycisk włączający.
   */
  unavailable: AiUnavailable | null;
}

/**
 * Funkcje, które wolno wywołać bez udziału użytkownika.
 *
 * Zasada: harmonogram może wydawać tokeny wyłącznie na streszczenia
 * wiadomości. Wszystko inne — komentarze, podsumowania, podpowiedzi — startuje
 * dopiero po kliknięciu, bo inaczej rachunek u dostawcy rośnie w tle i nie ma
 * jak połączyć go z czymkolwiek, o co użytkownik prosił.
 *
 * Lista jest egzekwowana w `completeWithMeta`, które wymaga podania źródła
 * wywołania. Dopisanie modelu do nowego zadania cyklicznego wymaga świadomej
 * zmiany tutaj, a nie tylko pamięci autora.
 */
export const SCHEDULED_FEATURES: readonly AiFeature[] = ['news'];

export type AiCallOrigin = 'user' | 'schedule';

/**
 * Funkcje, które nie wołają modelu językowego.
 *
 * Korzystają z tego samego mechanizmu zgód, bo też wysyłają coś na zewnątrz,
 * ale wymaganie od nich klucza dostawcy modelu byłoby bez sensu — nie mają
 * z niego jak skorzystać.
 */
const FEATURES_WITHOUT_MODEL: readonly AiFeature[] = ['analystConsensus'];

export function checkFeature(feature: AiFeature): AiAvailability {
  const settings = getAiSettings();

  /*
   * Kolejność sprawdzeń idzie od przyczyny najbardziej podstawowej. Brak klucza
   * zgłaszamy przed wyłączoną flagą: włączenie funkcji bez klucza i tak nic
   * nie da, a komunikat „funkcja wyłączona" kierował wtedy w złe miejsce.
   */
  const unavailable = (kind: AiUnavailableKind, message: string): AiAvailability => ({
    enabled: false,
    reason: message,
    unavailable: { kind, message, retryable: false },
  });

  const label = settings.provider === 'openai' ? 'OpenAI' : 'Anthropic';

  if (!FEATURES_WITHOUT_MODEL.includes(feature) && !apiKeyFor(settings.provider)) {
    return unavailable('no_key', `Brak klucza ${label} — wpisz go w Ustawieniach, w karcie „Funkcje AI".`);
  }

  if (!settings.features[feature]) {
    return unavailable('feature_off', `Funkcja „${AI_FEATURE_INFO[feature].label}" jest wyłączona w ustawieniach.`);
  }

  if (FEATURES_WITHOUT_MODEL.includes(feature)) return { enabled: true, reason: null, unavailable: null };

  if (!apiKeyFor(settings.provider)) {
    // Komunikat mówi wprost o wybranym dostawcy: przy `aiProvider = openai`
    // i kluczu Anthropic w `.env` samo „brak klucza" bywało mylące.
    return unavailable('no_key', `Brak klucza ${label} — wpisz go w Ustawieniach (dostawca: ${label}).`);
  }

  return { enabled: true, reason: null, unavailable: null };
}

/** Stan do pokazania w ustawieniach: co jest skonfigurowane, a co nie. */
export function aiStatus() {
  const settings = getAiSettings();
  return {
    provider: settings.provider,
    model: settings.model,
    /*
     * Gdy wybrany dostawca nie ma klucza, a drugi ma, korzystamy z drugiego.
     * Interfejs musi o tym powiedzieć, inaczej ustawienie „Anthropic" przy
     * działającym OpenAI wyglądałoby na zignorowane.
     */
    usingFallbackProvider: settings.usingFallbackProvider ?? false,
    chosenProvider: settings.chosenProvider ?? settings.provider,
    features: AI_FEATURES.map((feature) => ({
      ...AI_FEATURE_INFO[feature],
      enabled: settings.features[feature],
      available: checkFeature(feature).enabled,
      reason: checkFeature(feature).reason,
    })),
    keys: {
      anthropic: Boolean(apiKeyFor('anthropic')),
      openai: Boolean(apiKeyFor('openai')),
      anthropicMasked: maskApiKey(apiKeyFor('anthropic')),
      openaiMasked: maskApiKey(apiKeyFor('openai')),
      anthropicSource: apiKeySource('anthropic'),
      openaiSource: apiKeySource('openai'),
    },
    suggestedModels: SUGGESTED_MODELS,
  };
}
