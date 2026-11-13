import { getDb } from "@/lib/db";
import { logger } from "@/lib/logger";
import { telegramFromEnv } from "@/lib/telegram";
import { json } from "@/server/http/request";
import { syncTelegramDraftMessage } from "@/server/telegram/sync";
import { handleCalcomWebhook } from "@/server/webhooks/calcom";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ orgKey: string }> }) {
  const { orgKey } = await params;
  const db = getDb();
  try {
    return await handleCalcomWebhook(request, orgKey, {
      db,
      telegram: telegramFromEnv(),
      onCancelledDrafts: async (orgId, ids) => {
        for (const id of ids) await syncTelegramDraftMessage(db, orgId, id, "📅 They booked — this draft was cancelled.");
      },
    });
  } catch (err) {
    logger.error("calcom webhook failed", { err });
    return json({ error: "internal error" }, { status: 500 });
  }
}
