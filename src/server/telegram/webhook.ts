import { z } from "zod";
import type { Db } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { Queue } from "@/lib/queue";
import { escapeHtml, type Telegram } from "@/lib/telegram";
import {
  approveDraft,
  draftEditInput,
  DraftNotPendingError,
  editDraft,
  rejectDraft,
  type Actor,
} from "@/server/approvals";
import { draftWarnings } from "@/server/drafts";
import { getLead, markLeadResponded } from "@/server/leads/lifecycle";
import { draftButtons, draftMessage, editPrompt } from "@/server/telegram/messages";
import { consumeLinkCode } from "@/server/telegram/link";
import { DRAFT_COLUMNS, type Draft } from "@/server/types";

const chatSchema = z.object({ id: z.number().int(), type: z.string() });
const messageSchema = z.object({
  message_id: z.number().int(),
  chat: chatSchema,
  text: z.string().max(10_000).optional(),
  reply_to_message: z.object({ message_id: z.number().int(), text: z.string().optional() }).optional(),
});
export const telegramUpdateSchema = z.object({
  update_id: z.number().int(),
  message: messageSchema.optional(),
  callback_query: z
    .object({
      id: z.string(),
      data: z.string().max(64).optional(),
      message: messageSchema.optional(),
    })
    .optional(),
});
export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;

export interface TelegramDeps {
  db: Db;
  queue: Queue;
  telegram: Telegram;
}

const REF_RE = /ref:([0-9a-f-]{36})/;
const ACTION_RE = /^([aers]):([0-9a-f-]{36})$/;

/**
 * Loads a draft only if `chatId` is the Telegram chat linked to the draft's
 * organization. This is the authorization check for every bot action.
 */
async function draftForChat(db: Db, draftId: string, chatId: string): Promise<Draft | null> {
  const { rows } = await db.query<Draft>(
    `select ${DRAFT_COLUMNS} from public.drafts d
       join public.organizations o on o.id = d.org_id
      where d.id = $1 and o.telegram_chat_id = $2::bigint`,
    [draftId, chatId],
  );
  return rows[0] ?? null;
}

async function showDraft(deps: TelegramDeps, chatId: string, draft: Draft): Promise<void> {
  const lead = await getLead(deps.db, draft.org_id, draft.lead_id);
  if (!lead) return;
  const warnings = (await draftWarnings(deps.db, draft.org_id, [draft.id]))[draft.id] ?? [];
  const sent = await deps.telegram.sendMessage(chatId, draftMessage(lead, draft, warnings), {
    buttons: draftButtons(draft),
  });
  await deps.db.query("update public.drafts set telegram_message_id = $2::bigint where id = $1", [
    draft.id,
    sent.messageId,
  ]);
}

async function handleStart(deps: TelegramDeps, chat: { id: number; type: string }, text: string) {
  const chatId = String(chat.id);
  const code = text.split(/\s+/)[1];
  if (!code) {
    await deps.telegram.sendMessage(
      chatId,
      "Hi! I'm the DeskPilot bot. Open <b>Settings → Telegram</b> in DeskPilot and tap <b>Connect Telegram</b> to link this chat.",
    );
    return "help";
  }
  if (chat.type !== "private") {
    await deps.telegram.sendMessage(chatId, "For security, please link DeskPilot in a private chat with me.");
    return "not_private";
  }
  const org = await consumeLinkCode(deps.db, code, chatId);
  if (!org) {
    await deps.telegram.sendMessage(chatId, "That link has expired. Please create a new one in DeskPilot settings.");
    return "invalid_code";
  }
  await deps.telegram.sendMessage(
    chatId,
    `✅ Connected to <b>${escapeHtml(org.name)}</b>. New reply drafts will arrive here for your approval.`,
  );
  return "linked";
}

async function handleEditReply(deps: TelegramDeps, chatId: string, draftId: string, text: string) {
  const draft = await draftForChat(deps.db, draftId, chatId);
  if (!draft) return "not_found";
  const edit = draftEditInput.safeParse({ subject: draft.subject, body: text });
  if (!edit.success) {
    await deps.telegram.sendMessage(chatId, escapeHtml(edit.error.issues[0]?.message ?? "Invalid text"));
    return "invalid";
  }
  try {
    const updated = await editDraft(deps.db, draft.org_id, draft.id, { via: "telegram", chatId }, edit.data);
    await showDraft(deps, chatId, updated);
    return "edited";
  } catch (err) {
    if (err instanceof DraftNotPendingError) {
      await deps.telegram.sendMessage(chatId, "That draft was already handled.");
      return "not_pending";
    }
    throw err;
  }
}

async function handleCallback(
  deps: TelegramDeps,
  cb: NonNullable<TelegramUpdate["callback_query"]>,
): Promise<string> {
  const match = ACTION_RE.exec(cb.data ?? "");
  const chatId = cb.message ? String(cb.message.chat.id) : null;
  if (!match || !chatId || !cb.message) {
    await deps.telegram.answerCallback(cb.id, "Unknown action");
    return "unknown";
  }
  const [, action, draftId] = match as unknown as [string, "a" | "e" | "r" | "s", string];
  const draft = await draftForChat(deps.db, draftId, chatId);
  if (!draft) {
    await deps.telegram.answerCallback(cb.id, "This chat is not allowed to do that.");
    return "forbidden";
  }
  const actor: Actor = { via: "telegram", chatId };
  const messageId = String(cb.message.message_id);
  const original = cb.message.text ? escapeHtml(cb.message.text) : "";

  try {
    switch (action) {
      case "a": {
        await approveDraft(deps, draft.org_id, draft.id, actor);
        await deps.telegram.answerCallback(cb.id, "Approved — sending now");
        await deps.telegram.editMessage(chatId, messageId, `${original}\n\n✅ <b>Approved</b> — sending…`);
        return "approved";
      }
      case "r": {
        await rejectDraft(deps.db, draft.org_id, draft.id, actor);
        await deps.telegram.answerCallback(cb.id, "Rejected");
        await deps.telegram.editMessage(chatId, messageId, `${original}\n\n🗑 <b>Rejected</b>`);
        return "rejected";
      }
      case "e": {
        if (draft.status !== "pending_approval") throw new DraftNotPendingError();
        const lead = await getLead(deps.db, draft.org_id, draft.lead_id);
        if (!lead) return "not_found";
        await deps.telegram.answerCallback(cb.id, "Send the new text as a reply");
        await deps.telegram.sendMessage(chatId, editPrompt(lead, draft), { forceReply: true });
        return "edit_prompted";
      }
      case "s": {
        await markLeadResponded(deps.db, draft.org_id, draft.lead_id, "telegram");
        await deps.telegram.answerCallback(cb.id, "Follow-ups stopped");
        await deps.telegram.editMessage(chatId, messageId, `${original}\n\n🛑 <b>Follow-ups stopped</b>`);
        return "stopped";
      }
    }
  } catch (err) {
    if (err instanceof DraftNotPendingError) {
      await deps.telegram.answerCallback(cb.id, "Already handled");
      await deps.telegram.editMessage(chatId, messageId, `${original}\n\n(already handled)`);
      return "not_pending";
    }
    throw err;
  }
}

/** Handles one verified Telegram update. */
export async function handleTelegramUpdate(deps: TelegramDeps, update: TelegramUpdate): Promise<string> {
  if (update.callback_query) return handleCallback(deps, update.callback_query);

  const msg = update.message;
  if (!msg?.text) return "ignored";
  const chatId = String(msg.chat.id);
  const text = msg.text.trim();

  if (text.startsWith("/start")) return handleStart(deps, msg.chat, text);

  const ref = msg.reply_to_message?.text ? REF_RE.exec(msg.reply_to_message.text) : null;
  if (ref?.[1]) return handleEditReply(deps, chatId, ref[1], msg.text);

  logger.debug("telegram message ignored", { chatId });
  return "ignored";
}
