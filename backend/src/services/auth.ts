import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { sessions } from '../db/schema.js';
import { nowIso } from '../lib/dates.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('auth');

/**
 * Hasło z .env nigdy nie jest porównywane wprost. Przy starcie liczymy z niego
 * skrót scrypt (sól wyprowadzona z SESSION_SECRET, więc stała między restartami)
 * i porównujemy skróty w czasie stałym.
 */
const SALT = createHash('sha256').update(`pm-auth:${config.auth.sessionSecret}`).digest().subarray(0, 16);
const KEY_LEN = 64;
const expectedHash = scryptSync(config.auth.password, SALT, KEY_LEN);

export function verifyPassword(candidate: string): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 1024) return false;
  const actual = scryptSync(candidate, SALT, KEY_LEN);
  return timingSafeEqual(actual, expectedHash);
}

// ── Ograniczenie prób logowania ──────────────────────────────
// Aplikacja stoi w LAN/tailnecie, ale prosty throttling kosztuje nas kilka linii
// i zamyka temat zgadywania hasła przez skrypt.
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; firstAt: number }>();

export function isLockedOut(ip: string): number {
  const entry = attempts.get(ip);
  if (!entry) return 0;
  if (Date.now() - entry.firstAt > LOCKOUT_MS) {
    attempts.delete(ip);
    return 0;
  }
  if (entry.count < MAX_ATTEMPTS) return 0;
  return Math.ceil((LOCKOUT_MS - (Date.now() - entry.firstAt)) / 1000);
}

export function recordFailedAttempt(ip: string): void {
  const entry = attempts.get(ip);
  if (!entry || Date.now() - entry.firstAt > LOCKOUT_MS) {
    attempts.set(ip, { count: 1, firstAt: Date.now() });
    return;
  }
  entry.count += 1;
}

export function clearAttempts(ip: string): void {
  attempts.delete(ip);
}

// ── Sesje ────────────────────────────────────────────────────
export function createSession(userAgent: string | undefined, ip: string | undefined): { id: string; expiresAt: string } {
  const id = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.auth.sessionTtlHours * 3600_000).toISOString();
  db.insert(sessions)
    .values({ id, expiresAt, userAgent: userAgent ?? null, ip: ip ?? null })
    .run();
  return { id, expiresAt };
}

export function getValidSession(id: string | undefined): { id: string; expiresAt: string } | null {
  if (!id) return null;
  const row = db.select().from(sessions).where(eq(sessions.id, id)).get();
  if (!row) return null;
  if (row.expiresAt <= nowIso()) {
    destroySession(id);
    return null;
  }
  return { id: row.id, expiresAt: row.expiresAt };
}

export function destroySession(id: string): void {
  db.delete(sessions).where(eq(sessions.id, id)).run();
}

/** Sprzątanie wygasłych sesji — wołane przy starcie i raz na dobę przez cron. */
export function purgeExpiredSessions(): number {
  const res = db.delete(sessions).where(lt(sessions.expiresAt, nowIso())).run();
  if (res.changes > 0) log.debug(`Usunięto ${res.changes} wygasłych sesji`);
  return res.changes;
}
