import { config } from '../config.js';
import { errorMessage } from '../lib/errors.js';
import { fetchJson } from '../lib/http-client.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('telegram');

/**
 * Powiadomienia przez bota Telegram.
 *
 * Integracja jest opcjonalna: brak tokenu lub chat_id w `.env` oznacza, że
 * funkcja jest po prostu wyłączona. Aplikacja nigdy nie wywraca się z tego
 * powodu — alerty i tak zapisują się w bazie i są widoczne w interfejsie.
 */

export interface DeliveryResult {
  delivered: boolean;
  error: string | null;
}

export const isTelegramEnabled = (): boolean => config.telegram.enabled;

interface TelegramResponse {
  ok: boolean;
  description?: string;
  result?: { id: number; first_name?: string; username?: string };
}

export async function sendTelegramMessage(text: string): Promise<DeliveryResult> {
  if (!config.telegram.enabled) {
    return { delivered: false, error: 'Telegram nie jest skonfigurowany' };
  }

  const url = `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`;

  try {
    const response = await fetchJson<TelegramResponse>(url, {
      method: 'POST',
      // Telegram ogranicza tempo wysyłki; sekunda odstępu mieści się w limicie.
      minIntervalMs: 1200,
      retries: 2,
      body: {
        chat_id: config.telegram.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      },
    });

    if (!response.ok) {
      return { delivered: false, error: response.description ?? 'Telegram odrzucił wiadomość' };
    }
    return { delivered: true, error: null };
  } catch (err) {
    const message = errorMessage(err);
    log.warn(`Nie udało się wysłać powiadomienia: ${message}`);
    return { delivered: false, error: message };
  }
}

/** Test połączenia — używany przez panel ustawień. */
export async function testTelegram(): Promise<{ ok: boolean; message: string }> {
  if (!config.telegram.enabled) {
    return {
      ok: false,
      message: 'Brak TELEGRAM_BOT_TOKEN lub TELEGRAM_CHAT_ID w pliku .env — powiadomienia są wyłączone.',
    };
  }

  const result = await sendTelegramMessage(
    '✅ <b>Portfolio Manager</b>\nPołączenie z botem działa. To wiadomość testowa.',
  );

  return result.delivered
    ? { ok: true, message: 'Wiadomość testowa wysłana.' }
    : { ok: false, message: `Nie udało się wysłać: ${result.error}` };
}

/** Escapowanie dla parse_mode=HTML — nazwy spółek potrafią zawierać `&`. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
