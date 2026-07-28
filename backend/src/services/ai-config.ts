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
}

const DEFAULT_FEATURES: Record<AiFeature, boolean> = {
  news: false,
  insights: false,
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
  const provider = getSetting<AiProvider>('aiProvider', 'anthropic');
  const stored = getSetting<Partial<Record<AiFeature, boolean>>>('aiFeatures', {});

  return {
    provider,
    model: getSetting<string>('aiModel', defaultModelFor(provider)),
    features: { ...DEFAULT_FEATURES, ...stored },
  };
}

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

/** Klucz dla wskazanego dostawcy; null, gdy nie ustawiono go w `.env`. */
export function apiKeyFor(provider: AiProvider): string | null {
  return provider === 'openai' ? (config.ai.openAiKey ?? null) : (config.ai.apiKey ?? null);
}

export interface AiAvailability {
  /** Czy dana funkcja może teraz zadziałać: włączona i z dostępnym kluczem. */
  enabled: boolean;
  reason: string | null;
}

export function checkFeature(feature: AiFeature): AiAvailability {
  const settings = getAiSettings();

  if (!settings.features[feature]) {
    return { enabled: false, reason: `Funkcja „${AI_FEATURE_INFO[feature].label}" jest wyłączona w ustawieniach.` };
  }

  if (!apiKeyFor(settings.provider)) {
    const variable = settings.provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
    return { enabled: false, reason: `Brak ${variable} w pliku .env.` };
  }

  return { enabled: true, reason: null };
}

/** Stan do pokazania w ustawieniach: co jest skonfigurowane, a co nie. */
export function aiStatus() {
  const settings = getAiSettings();
  return {
    provider: settings.provider,
    model: settings.model,
    features: AI_FEATURES.map((feature) => ({
      ...AI_FEATURE_INFO[feature],
      enabled: settings.features[feature],
      available: checkFeature(feature).enabled,
      reason: checkFeature(feature).reason,
    })),
    keys: {
      anthropic: Boolean(config.ai.apiKey),
      openai: Boolean(config.ai.openAiKey),
    },
    suggestedModels: SUGGESTED_MODELS,
  };
}
