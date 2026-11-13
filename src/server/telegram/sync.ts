import type { Db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { telegramFromEnv } from "@/lib/telegram";

/**
 * After a draft is handled on the web, update its Telegram message so the
 * buttons disappear there too. Best effort: never fails the web action.
 */
export async function syncTelegramDraftMessage(db: Db, orgId: string, draftId: string, label: string): Promise<void> {
  try {
    const telegram = telegramFromEnv();
    if (!telegram) return;
    const { rows } = await db.query<{ chat_id: string | null; message_id: string | null }>(
      `select o.telegram_chat_id::text as chat_id, d.telegram_message_id::text as message_id
         from public.drafts d join public.organizations o on o.id = d.org_id
        where d.id = $1 and d.org_id = $2`,
      [draftId, orgId],
    );
    const row = rows[0];
    if (!row?.chat_id || !row.message_id) return;
    await telegram.editMessage(row.chat_id, row.message_id, label);
  } catch (err) {
    logger.warn("telegram sync failed", { err, draftId });
  }
}
