import type { Db } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { Queue } from "@/lib/queue";
import { verifyTelegramSecret, type Telegram } from "@/lib/telegram";
import { BodyTooLargeError, readBodyText } from "@/server/http/request";
import { handleTelegramUpdate, telegramUpdateSchema } from "@/server/telegram/webhook";

/** POST /api/webhooks/telegram — verifies the secret header, then handles the update. */
export async function handleTelegramWebhookRequest(
  req: Request,
  deps: { db: Db; queue: Queue; telegram: Telegram | null; secret: string | undefined },
): Promise<Response> {
  if (!verifyTelegramSecret(req.headers.get("x-telegram-bot-api-secret-token"), deps.secret)) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!deps.telegram) return new Response("Telegram not configured", { status: 503 });

  let body: unknown;
  try {
    body = JSON.parse(await readBodyText(req, 64 * 1024));
  } catch (err) {
    return new Response(err instanceof BodyTooLargeError ? "Too large" : "Bad request", { status: 400 });
  }
  const update = telegramUpdateSchema.safeParse(body);
  // Always 200 for updates we don't understand, or Telegram keeps re-sending them.
  if (!update.success) return new Response("ok");

  try {
    await handleTelegramUpdate({ db: deps.db, queue: deps.queue, telegram: deps.telegram }, update.data);
  } catch (err) {
    logger.error("telegram update failed", { err, updateId: update.data.update_id });
    return new Response("error", { status: 500 }); // Telegram retries later
  }
  return new Response("ok");
}
