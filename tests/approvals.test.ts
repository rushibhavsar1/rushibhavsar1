import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asUser } from "@/lib/db";
import { approveDraft, DraftNotPendingError, editDraft, rejectDraft, requestNewDraft } from "@/server/approvals";
import { listNeedsAttention, listPendingDrafts } from "@/server/inbox";
import { notifyOwner } from "@/server/jobs/notify";
import { stopFollowups } from "@/server/leads/lifecycle";
import type { Organization } from "@/server/types";
import { createTestDb, type TestDatabase } from "./helpers/db";
import { FakeQueue, FakeTelegram } from "./helpers/fakes";
import { createOrgFixture, insertDraft, insertLead } from "./helpers/fixtures";

describe("approval inbox", () => {
  let t: TestDatabase;
  let org: Organization;
  let owner: string;
  const queue = new FakeQueue();

  beforeAll(async () => {
    t = await createTestDb();
    ({ org, userId: owner } = await createOrgFixture(t.db));
  });
  afterAll(() => t.close());
  beforeEach(() => queue.clear());

  const web = () => ({ via: "web" as const, userId: owner });
  const draftRow = async (id: string) =>
    (
      await t.db.query<{ status: string; subject: string; body: string; approved_via: string | null }>(
        "select status, subject, body, approved_via from public.drafts where id = $1",
        [id],
      )
    ).rows[0]!;

  it("lists pending drafts next to the original lead message (read with RLS)", async () => {
    const leadId = await insertLead(t.db, org.id, { message: "How much is whitening?" });
    const draftId = await insertDraft(t.db, org.id, leadId);
    const other = await createOrgFixture(t.db);
    await insertDraft(t.db, other.org.id, await insertLead(t.db, other.org.id));

    const items = await asUser(t.db, owner, (tx) => listPendingDrafts(tx, org.id));
    expect(items.map((i) => i.draft.id)).toContain(draftId);
    expect(items.find((i) => i.draft.id === draftId)!.lead.message).toBe("How much is whitening?");
    // Even asking for the other org's id as this user returns nothing.
    expect(await asUser(t.db, owner, (tx) => listPendingDrafts(tx, other.org.id))).toEqual([]);
  });

  it("approve (with edits) is the only thing that enqueues sending", async () => {
    const leadId = await insertLead(t.db, org.id);
    const draftId = await insertDraft(t.db, org.id, leadId);
    await approveDraft({ db: t.db, queue }, org.id, draftId, web(), { subject: "New subject", body: "Edited body" });

    expect(await draftRow(draftId)).toEqual({
      status: "approved",
      subject: "New subject",
      body: "Edited body",
      approved_via: "web",
    });
    expect(queue.ofType("send_draft")).toEqual([
      expect.objectContaining({ data: { draftId, orgId: org.id } }),
    ]);
    // Approving twice (e.g. web + Telegram at the same time) does nothing the second time.
    await expect(approveDraft({ db: t.db, queue }, org.id, draftId, web())).rejects.toBeInstanceOf(
      DraftNotPendingError,
    );
    expect(queue.ofType("send_draft")).toHaveLength(1);
  });

  it("cannot approve a draft from another organization", async () => {
    const other = await createOrgFixture(t.db);
    const draftId = await insertDraft(t.db, other.org.id, await insertLead(t.db, other.org.id));
    await expect(approveDraft({ db: t.db, queue }, org.id, draftId, web())).rejects.toBeInstanceOf(
      DraftNotPendingError,
    );
    expect(queue.jobs).toHaveLength(0);
  });

  it("editing saves without approving; rejecting a first reply sends the lead back for a new draft", async () => {
    const leadId = await insertLead(t.db, org.id, { status: "awaiting_approval" });
    const draftId = await insertDraft(t.db, org.id, leadId);
    await editDraft(t.db, org.id, draftId, web(), { subject: "S", body: "B" });
    expect(await draftRow(draftId)).toMatchObject({ status: "pending_approval", body: "B" });

    await rejectDraft(t.db, org.id, draftId, web());
    expect((await draftRow(draftId)).status).toBe("rejected");
    const lead = await t.db.query<{ status: string }>("select status from public.leads where id = $1", [leadId]);
    expect(lead.rows[0]!.status).toBe("new");

    const attention = await listNeedsAttention(t.db, org.id);
    expect(attention.find((a) => a.lead.id === leadId)?.reason).toBe("rejected");

    expect(await requestNewDraft({ db: t.db, queue }, org.id, leadId)).toBe(true);
    expect(queue.ofType("process_lead")).toHaveLength(1);
  });

  it("a follow-up cannot be approved once follow-ups are stopped", async () => {
    const leadId = await insertLead(t.db, org.id, { status: "replied" });
    const draftId = await insertDraft(t.db, org.id, leadId, { kind: "followup_1" });
    await t.db.query("update public.leads set followups_stopped_at = now() where id = $1", [leadId]);
    await expect(approveDraft({ db: t.db, queue }, org.id, draftId, web())).rejects.toBeInstanceOf(
      DraftNotPendingError,
    );
    // stopFollowups also cancels it outright.
    await t.db.query("update public.leads set followups_stopped_at = null where id = $1", [leadId]);
    await stopFollowups(t.db, org.id, leadId, "manual");
    expect((await draftRow(draftId)).status).toBe("cancelled");
  });

  it("notify_owner marks the lead awaiting approval and uses Telegram when linked", async () => {
    const telegram = new FakeTelegram();
    const leadId = await insertLead(t.db, org.id, { status: "drafted" });
    const draftId = await insertDraft(t.db, org.id, leadId);

    expect(await notifyOwner({ db: t.db, telegram }, { draftId, orgId: org.id })).toBe("web");
    expect(telegram.calls).toHaveLength(0);
    const lead = await t.db.query<{ status: string }>("select status from public.leads where id = $1", [leadId]);
    expect(lead.rows[0]!.status).toBe("awaiting_approval");

    await t.db.query("update public.organizations set telegram_chat_id = 555 where id = $1", [org.id]);
    expect(await notifyOwner({ db: t.db, telegram }, { draftId, orgId: org.id })).toBe("web+telegram");
    const sent = telegram.sent()[0]!;
    expect(sent.chatId).toBe("555");
    expect(sent.text).toContain("Their message");
    expect(sent.buttons?.[0]?.map((b) => b.callback_data)).toEqual([`a:${draftId}`, `e:${draftId}`, `r:${draftId}`]);
    const stored = await t.db.query<{ m: string }>("select telegram_message_id::text as m from public.drafts where id = $1", [
      draftId,
    ]);
    expect(stored.rows[0]!.m).toBe("101");
    await t.db.query("update public.organizations set telegram_chat_id = null where id = $1", [org.id]);
  });
});
