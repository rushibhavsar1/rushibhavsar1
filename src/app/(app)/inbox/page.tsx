import type { Metadata } from "next";
import Link from "next/link";
import { DraftEditor } from "@/components/client/draft-card";
import { timeAgo } from "@/components/format";
import { requireOrgContext, withUserDb } from "@/server/auth/context";
import { listNeedsAttention, listPendingDrafts } from "@/server/inbox";
import { draftAction, leadAction } from "./actions";

export const metadata: Metadata = { title: "Inbox" };

const KIND_LABEL = { first_reply: "First reply", followup_1: "Follow-up · day 2", followup_2: "Follow-up · day 5" };
const REASON_LABEL = {
  support: "Support question — answer personally",
  ai_blocked: "AI paused (billing, monthly AI budget or lead limit)",
  ai_refused: "AI could not draft a reply",
  rejected: "You rejected the draft",
  waiting: "Waiting for AI",
};

export default async function InboxPage() {
  const ctx = await requireOrgContext();
  const [pending, attention] = await withUserDb(ctx, async (tx) =>
    Promise.all([listPendingDrafts(tx, ctx.org.id), listNeedsAttention(tx, ctx.org.id)]),
  );

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-semibold">Inbox</h1>
        <p className="mt-1 text-sm text-slate-600">
          Nothing is sent until you approve it.{" "}
          {ctx.org.telegram_chat_id ? null : (
            <Link href="/settings/telegram" className="text-brand-600 hover:underline">
              Get drafts on your phone with Telegram.
            </Link>
          )}
        </p>
      </div>

      <section className="space-y-6">
        <h2 className="text-lg font-semibold">
          Waiting for approval <span className="text-slate-500">({pending.length})</span>
        </h2>
        {pending.length === 0 ? (
          <p className="card text-sm text-slate-600">All caught up. New drafts will appear here.</p>
        ) : (
          pending.map(({ draft, lead, warnings }) => (
            <article key={draft.id} className="card grid gap-6 lg:grid-cols-2">
              <div className="min-w-0">
                <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                  {KIND_LABEL[draft.kind]} · received {timeAgo(lead.created_at)}
                </p>
                <h3 className="mt-1 font-semibold">
                  <Link href={`/leads/${lead.id}`} className="hover:underline">
                    {lead.name ?? lead.email}
                  </Link>
                </h3>
                <p className="text-sm text-slate-600">
                  {lead.email}
                  {lead.phone ? ` · ${lead.phone}` : ""} · via {lead.source}
                </p>
                <blockquote className="mt-3 rounded-md border-l-4 border-slate-300 bg-slate-50 p-3 text-sm whitespace-pre-wrap">
                  {lead.message}
                </blockquote>
                {warnings.length > 0 ? (
                  <ul className="mt-3 space-y-1 rounded-md bg-amber-50 p-3 text-sm text-amber-800">
                    {warnings.map((w) => (
                      <li key={w}>⚠️ {w}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <div className="min-w-0">
                <DraftEditor draftId={draft.id} subject={draft.subject} body={draft.body} action={draftAction} />
              </div>
            </article>
          ))
        )}
      </section>

      {attention.length > 0 ? (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">
            Needs your attention <span className="text-slate-500">({attention.length})</span>
          </h2>
          {attention.map(({ lead, reason, detail }) => (
            <article key={lead.id} className="card">
              <p className="text-xs font-medium tracking-wide text-amber-700 uppercase">
                {REASON_LABEL[reason]}
                {detail ? ` (${detail.replace("_", " ")})` : ""}
              </p>
              <h3 className="mt-1 font-semibold">
                <Link href={`/leads/${lead.id}`} className="hover:underline">
                  {lead.name ?? lead.email}
                </Link>{" "}
                <span className="text-sm font-normal text-slate-500">· {timeAgo(lead.created_at)}</span>
              </h3>
              <p className="text-sm text-slate-600">
                <a href={`mailto:${lead.email}`} className="hover:underline">
                  {lead.email}
                </a>
                {lead.phone ? ` · ${lead.phone}` : ""}
              </p>
              <blockquote className="mt-3 rounded-md bg-slate-50 p-3 text-sm whitespace-pre-wrap">
                {lead.message}
              </blockquote>
              <form action={leadAction} className="mt-4 flex flex-wrap gap-2">
                <input type="hidden" name="leadId" value={lead.id} />
                {reason !== "support" ? (
                  <button name="intent" value="redraft" className="btn-primary">
                    Write a new draft
                  </button>
                ) : null}
                <button name="intent" value="handled" className="btn-secondary">
                  I replied myself
                </button>
                <button name="intent" value="lost" className="btn-danger">
                  Not a lead
                </button>
              </form>
            </article>
          ))}
        </section>
      ) : null}
    </div>
  );
}
