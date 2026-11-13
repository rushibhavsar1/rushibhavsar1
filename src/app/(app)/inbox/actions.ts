"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import type { FormState } from "@/lib/form";
import { logger } from "@/lib/logger";
import { getQueue } from "@/lib/queue";
import {
  approveDraft,
  draftEditInput,
  DraftNotPendingError,
  editDraft,
  rejectDraft,
  requestNewDraft,
  type Actor,
} from "@/server/approvals";
import { requireOrgContext } from "@/server/auth/context";
import { getDraft } from "@/server/drafts";
import { markLeadHandled, markLeadLost, markLeadResponded } from "@/server/leads/lifecycle";
import { syncTelegramDraftMessage } from "@/server/telegram/sync";

const UUID = /^[0-9a-f-]{36}$/;

function refresh() {
  revalidatePath("/inbox");
  revalidatePath("/leads", "layout");
  revalidatePath("/dashboard");
}

/** Approve / save / reject a draft from the web inbox. */
export async function draftAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireOrgContext();
  const draftId = String(formData.get("draftId") ?? "");
  const intent = String(formData.get("intent") ?? "");
  if (!UUID.test(draftId)) return { error: "Unknown draft." };
  const db = getDb();
  const actor: Actor = { via: "web", userId: ctx.user.id };

  try {
    if (intent === "reject") {
      await rejectDraft(db, ctx.org.id, draftId, actor);
      await syncTelegramDraftMessage(db, ctx.org.id, draftId, "🗑 Rejected on the web.");
      refresh();
      return { ok: true, message: "Draft rejected." };
    }

    const parsed = draftEditInput.safeParse({ subject: formData.get("subject"), body: formData.get("body") });
    if (!parsed.success) {
      return { fieldErrors: Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])) };
    }
    const current = await getDraft(db, ctx.org.id, draftId);
    if (!current) return { error: "Unknown draft." };
    const changed = current.subject !== parsed.data.subject || current.body !== parsed.data.body;

    if (intent === "save") {
      if (changed) await editDraft(db, ctx.org.id, draftId, actor, parsed.data);
      refresh();
      return { ok: true, message: "Saved." };
    }
    if (intent === "approve") {
      await approveDraft({ db, queue: getQueue() }, ctx.org.id, draftId, actor, changed ? parsed.data : undefined);
      await syncTelegramDraftMessage(db, ctx.org.id, draftId, "✅ Approved on the web — sending…");
      refresh();
      return { ok: true, message: "Approved — sending now." };
    }
    return { error: "Unknown action." };
  } catch (err) {
    if (err instanceof DraftNotPendingError) {
      refresh();
      return { error: err.message };
    }
    logger.error("draft action failed", { err, draftId, intent });
    return { error: "Something went wrong. Please try again." };
  }
}

/** Lead-level actions from the inbox and lead pages. */
export async function leadAction(formData: FormData): Promise<void> {
  const ctx = await requireOrgContext();
  const leadId = String(formData.get("leadId") ?? "");
  const intent = String(formData.get("intent") ?? "");
  if (!UUID.test(leadId)) return;
  const db = getDb();
  switch (intent) {
    case "redraft":
      await requestNewDraft({ db, queue: getQueue() }, ctx.org.id, leadId);
      break;
    case "lost":
      await markLeadLost(db, ctx.org.id, leadId, ctx.user.id);
      break;
    case "handled":
      await markLeadHandled(db, ctx.org.id, leadId, ctx.user.id);
      break;
    case "responded":
      await markLeadResponded(db, ctx.org.id, leadId, "web");
      break;
    default:
      return;
  }
  refresh();
}
