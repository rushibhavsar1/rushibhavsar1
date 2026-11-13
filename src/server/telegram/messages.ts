import { escapeHtml, truncate, type InlineButton } from "@/lib/telegram";
import { appUrl } from "@/lib/urls";
import type { Draft, Lead } from "@/server/types";

const KIND_LABEL: Record<Draft["kind"], string> = {
  first_reply: "New lead — reply draft",
  followup_1: "Follow-up #1 (day 2)",
  followup_2: "Follow-up #2 (day 5)",
};

/** Telegram rejects localhost URLs in buttons, so only link out on https. */
function webButton(path: string): InlineButton[] {
  const url = appUrl(path);
  return url.startsWith("https://") ? [{ text: "Open in DeskPilot", url }] : [];
}

function leadLine(lead: Pick<Lead, "name" | "email" | "phone">): string {
  const who = lead.name ? `${escapeHtml(lead.name)} &lt;${escapeHtml(lead.email)}&gt;` : escapeHtml(lead.email);
  return lead.phone ? `${who} · ${escapeHtml(lead.phone)}` : who;
}

/** The approval message: lead's message next to the draft, with buttons. */
export function draftMessage(lead: Lead, draft: Draft, warnings: string[]): string {
  const parts = [
    `<b>${KIND_LABEL[draft.kind]}</b>`,
    `From: ${leadLine(lead)}`,
    "",
    "<b>Their message</b>",
    `<blockquote>${escapeHtml(truncate(lead.message, 1200))}</blockquote>`,
    "<b>Draft reply</b>",
    `Subject: ${escapeHtml(draft.subject)}`,
    `<pre>${escapeHtml(truncate(draft.body, 2000))}</pre>`,
  ];
  if (warnings.length > 0) {
    parts.push(`⚠️ ${warnings.map(escapeHtml).join("\n⚠️ ")}`);
  }
  parts.push(`<i>ref:${draft.id}</i>`);
  return parts.join("\n");
}

export function draftButtons(draft: Pick<Draft, "id" | "kind">): InlineButton[][] {
  const rows: InlineButton[][] = [
    [
      { text: "✅ Approve & send", callback_data: `a:${draft.id}` },
      { text: "✏️ Edit", callback_data: `e:${draft.id}` },
      { text: "🗑 Reject", callback_data: `r:${draft.id}` },
    ],
  ];
  if (draft.kind !== "first_reply") {
    rows.push([{ text: "🛑 They replied or booked — stop follow-ups", callback_data: `s:${draft.id}` }]);
  }
  const web = webButton("/inbox");
  if (web.length) rows.push(web);
  return rows;
}

export function supportMessage(lead: Lead, reason: "support" | "refused"): string {
  const title =
    reason === "support"
      ? "📩 <b>Support question</b> — please answer this one personally"
      : "📩 <b>New message needs your reply</b> — DeskPilot could not draft one";
  return [
    title,
    `From: ${leadLine(lead)}`,
    `<blockquote>${escapeHtml(truncate(lead.message, 2500))}</blockquote>`,
  ].join("\n");
}

export function supportButtons(leadId: string): InlineButton[][] {
  const web = webButton(`/leads/${leadId}`);
  return web.length ? [web] : [];
}

export function editPrompt(lead: Lead, draft: Draft): string {
  return [
    `✏️ Reply to this message with the new email text for ${escapeHtml(lead.name ?? lead.email)}.`,
    "Your text replaces the whole body. The subject stays the same.",
    "",
    "Current text:",
    `<pre>${escapeHtml(truncate(draft.body, 3000))}</pre>`,
    `<i>ref:${draft.id}</i>`,
  ].join("\n");
}
