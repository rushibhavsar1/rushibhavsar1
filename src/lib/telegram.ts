import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/** Minimal Telegram Bot API client (only what DeskPilot needs). */
export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface Telegram {
  sendMessage(
    chatId: string,
    html: string,
    opts?: { buttons?: InlineButton[][]; forceReply?: boolean },
  ): Promise<{ messageId: string }>;
  editMessage(chatId: string, messageId: string, html: string, opts?: { buttons?: InlineButton[][] }): Promise<void>;
  answerCallback(callbackQueryId: string, text?: string): Promise<void>;
}

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly description: string,
    readonly status: number,
  ) {
    super(`Telegram ${method} failed (${status}): ${description}`);
  }
}

export function createTelegram(token: string, fetchFn: typeof fetch = fetch): Telegram {
  async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!res.ok || !data.ok) throw new TelegramApiError(method, data.description ?? "unknown error", res.status);
    return data.result as T;
  }

  const markup = (buttons?: InlineButton[][]) => (buttons ? { inline_keyboard: buttons } : undefined);

  return {
    async sendMessage(chatId, html, opts = {}) {
      const result = await call<{ message_id: number }>("sendMessage", {
        chat_id: chatId,
        text: html,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: opts.forceReply ? { force_reply: true } : markup(opts.buttons),
      });
      return { messageId: String(result.message_id) };
    },
    async editMessage(chatId, messageId, html, opts = {}) {
      try {
        await call("editMessageText", {
          chat_id: chatId,
          message_id: Number(messageId),
          text: html,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: markup(opts.buttons) ?? { inline_keyboard: [] },
        });
      } catch (err) {
        // Editing to identical content is not an error worth failing over.
        if (err instanceof TelegramApiError && err.description.includes("message is not modified")) return;
        throw err;
      }
    },
    async answerCallback(callbackQueryId, text) {
      await call("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
    },
  };
}

/** The configured bot, or null when Telegram is not set up. */
export function telegramFromEnv(): Telegram | null {
  const token = env().TELEGRAM_BOT_TOKEN;
  return token ? createTelegram(token) : null;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Verifies a webhook request really comes from Telegram: setWebhook was called
 * with secret_token, and Telegram echoes it in this header on every update.
 */
export function verifyTelegramSecret(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
