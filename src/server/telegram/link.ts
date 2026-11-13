import { randomBytes } from "node:crypto";
import type { Db } from "@/lib/db";
import { recordEvent } from "@/server/events";

const LINK_TTL_MINUTES = 30;

/** One-time code the owner sends to the bot (via a t.me deep link) to link their chat. */
export async function createLinkCode(db: Db, orgId: string): Promise<string> {
  const code = randomBytes(16).toString("hex");
  await db.query(
    `update public.organizations
        set telegram_link_code = $2, telegram_link_expires_at = now() + make_interval(mins => $3)
      where id = $1`,
    [orgId, code, LINK_TTL_MINUTES],
  );
  return code;
}

/** Links the chat to the org owning `code`. Returns the org, or null if the code is invalid/expired. */
export async function consumeLinkCode(
  db: Db,
  code: string,
  chatId: string,
): Promise<{ id: string; name: string } | null> {
  if (!/^[a-f0-9]{32}$/.test(code)) return null;
  const { rows } = await db.query<{ id: string; name: string }>(
    `update public.organizations
        set telegram_chat_id = $2::bigint, telegram_link_code = null, telegram_link_expires_at = null
      where telegram_link_code = $1 and telegram_link_expires_at > now()
      returning id, name`,
    [code, chatId],
  );
  const org = rows[0] ?? null;
  if (org) await recordEvent(db, org.id, "telegram_linked", { chat_id: chatId });
  return org;
}

export async function unlinkTelegram(db: Db, orgId: string): Promise<void> {
  await db.query(
    `update public.organizations
        set telegram_chat_id = null, telegram_link_code = null, telegram_link_expires_at = null
      where id = $1`,
    [orgId],
  );
  await recordEvent(db, orgId, "telegram_unlinked");
}
