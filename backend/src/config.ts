import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Wczytanie .env bez zewnętrznej zależności — plik ma prosty format,
 * a `dotenv` byłby dodatkową paczką dla trzydziestu linijek kodu.
 */
function loadEnvFile(): void {
  const candidates = [
    process.env.ENV_FILE,
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../.env'),
  ].filter((p): p is string => Boolean(p));

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const content = readFileSync(file, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      // Zmienne z otoczenia (docker-compose, systemd) mają pierwszeństwo.
      if (process.env[key] === undefined) process.env[key] = value;
    }
    break;
  }
}

/**
 * Katalog danych ma być ten sam niezależnie od tego, czy uruchamiamy backend
 * z `backend/` (dev) czy z `/app` (Docker) — inaczej dev tworzyłby drugą bazę
 * obok produkcyjnej. Szukamy katalogu z rootowym package.json.
 */
function projectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const pkg = path.join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const content = JSON.parse(readFileSync(pkg, 'utf8')) as { workspaces?: unknown };
        if (content.workspaces) return dir;
      } catch {
        // Uszkodzony package.json po drodze nie powinien przerywać szukania.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

loadEnvFile();

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : /^(1|true|yes|on)$/i.test(v)));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),
  TZ: z.string().default('Europe/Warsaw'),

  APP_PASSWORD: z.string().min(1, 'APP_PASSWORD jest wymagane — ustaw je w .env'),
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET musi mieć co najmniej 16 znaków'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(8760).default(720),
  COOKIE_SECURE: bool(false),

  DATABASE_PATH: z.string().default('./data/portfolio.sqlite'),

  PRICE_REFRESH_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  MARKET_HOURS: z
    .string()
    .regex(/^\d{1,2}-\d{1,2}$/)
    .default('9-23'),
  BASE_CURRENCY: z.string().length(3).default('PLN'),
  DISABLE_EXTERNAL_FETCH: bool(false),

  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  OPENAI_MODEL: z.string().default('gpt-5-mini'),
  AI_NEWS_BATCH_LIMIT: z.coerce.number().int().min(1).max(500).default(25),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),

  CRON_PRICES_ENABLED: bool(true),
  CRON_FX_ENABLED: bool(true),
  CRON_SNAPSHOT_ENABLED: bool(true),
  CRON_NEWS_ENABLED: bool(true),
  CRON_ALERTS_ENABLED: bool(true),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // Świadomie kończymy proces: bez hasła i sekretu sesji aplikacja nie może
  // wystartować bezpiecznie, a ciche uruchomienie z domyślnymi byłoby gorsze.
  console.error(`Błędna konfiguracja .env:\n${issues}\n\nSkopiuj .env.example do .env i uzupełnij.`);
  process.exit(1);
}

const env = parsed.data;
const [marketOpen, marketClose] = env.MARKET_HOURS.split('-').map(Number) as [number, number];

export const config = {
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  port: env.PORT,
  host: env.HOST,
  timezone: env.TZ,

  auth: {
    password: env.APP_PASSWORD,
    sessionSecret: env.SESSION_SECRET,
    sessionTtlHours: env.SESSION_TTL_HOURS,
    cookieSecure: env.COOKIE_SECURE,
    cookieName: 'pm_session',
  },

  databasePath: path.isAbsolute(env.DATABASE_PATH)
    ? env.DATABASE_PATH
    : path.resolve(projectRoot(), env.DATABASE_PATH),

  prices: {
    refreshMinutes: env.PRICE_REFRESH_MINUTES,
    marketOpenHour: marketOpen,
    marketCloseHour: marketClose,
    disableExternalFetch: env.DISABLE_EXTERNAL_FETCH,
  },

  baseCurrency: env.BASE_CURRENCY.toUpperCase(),

  ai: {
    // Obecność klucza znaczy tylko tyle, że funkcje AI *da się* włączyć.
    // O tym, czy działają, decyduje zgoda zapisana w ustawieniach.
    enabled: Boolean(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY),
    apiKey: env.ANTHROPIC_API_KEY,
    openAiKey: env.OPENAI_API_KEY,
    model: env.ANTHROPIC_MODEL,
    openAiModel: env.OPENAI_MODEL,
    batchLimit: env.AI_NEWS_BATCH_LIMIT,
  },

  telegram: {
    enabled: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
    botToken: env.TELEGRAM_BOT_TOKEN,
    chatId: env.TELEGRAM_CHAT_ID,
  },

  cron: {
    prices: env.CRON_PRICES_ENABLED,
    fx: env.CRON_FX_ENABLED,
    snapshot: env.CRON_SNAPSHOT_ENABLED,
    news: env.CRON_NEWS_ENABLED,
    alerts: env.CRON_ALERTS_ENABLED,
  },
} as const;

export type Config = typeof config;
