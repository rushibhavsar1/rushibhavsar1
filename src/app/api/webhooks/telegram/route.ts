import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { getQueue } from "@/lib/queue";
import { telegramFromEnv } from "@/lib/telegram";
import { handleTelegramWebhookRequest } from "@/server/telegram/endpoint";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleTelegramWebhookRequest(request, {
    db: getDb(),
    queue: getQueue(),
    telegram: telegramFromEnv(),
    secret: env().TELEGRAM_WEBHOOK_SECRET,
  });
}
