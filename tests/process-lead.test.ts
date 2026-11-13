import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAi } from "@/lib/ai";
import { processLead } from "@/server/jobs/process-lead";
import { saveKnowledgeFile } from "@/server/knowledge";
import type { Organization } from "@/server/types";
import { createTestDb, type TestDatabase } from "./helpers/db";
import { fakeAnthropic, scriptedModel } from "./helpers/fake-anthropic";
import { FakeQueue } from "./helpers/fakes";
import { createOrgFixture, insertLead } from "./helpers/fixtures";

describe("process_lead job", () => {
  let t: TestDatabase;
  let org: Organization;
  const queue = new FakeQueue();

  beforeAll(async () => {
    t = await createTestDb();
    org = (await createOrgFixture(t.db)).org;
    await saveKnowledgeFile(t.db, org.id, "booking", "https://cal.com/brightsmile/intro");
  });
  afterAll(() => t.close());
  beforeEach(() => queue.clear());

  function deps(category: "lead" | "support" | "spam" = "lead") {
    const api = fakeAnthropic(scriptedModel({ category }));
    return { api, deps: { db: t.db, queue, ai: createAi({ db: t.db, client: api.client }) } };
  }

  async function leadState(id: string) {
    const lead = await t.db.query<{ status: string; classification: string | null }>(
      "select status, classification from public.leads where id = $1",
      [id],
    );
    const drafts = await t.db.query<{ id: string; kind: string; status: string; model: string; subject: string }>(
      "select id, kind, status, model, subject from public.drafts where lead_id = $1",
      [id],
    );
    return { lead: lead.rows[0]!, drafts: drafts.rows };
  }

  it("classifies a real lead and drafts a reply that waits for approval", async () => {
    const leadId = await insertLead(t.db, org.id);
    const { api, deps: d } = deps("lead");
    expect(await processLead(d, { leadId, orgId: org.id })).toBe("drafted");

    const state = await leadState(leadId);
    expect(state.lead).toEqual({ status: "drafted", classification: "lead" });
    expect(state.drafts).toEqual([
      expect.objectContaining({ kind: "first_reply", status: "pending_approval", model: "claude-sonnet-5-5" }),
    ]);
    expect(api.requests.map((r) => r.body.model)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
    expect(queue.ofType("notify_owner")).toEqual([
      expect.objectContaining({ data: { draftId: state.drafts[0]!.id, orgId: org.id } }),
    ]);
    // Nothing is ever sent without approval.
    expect(queue.ofType("send_draft")).toHaveLength(0);
  });

  it("is safe to retry: no second classification or draft", async () => {
    const leadId = await insertLead(t.db, org.id);
    const first = deps("lead");
    await processLead(first.deps, { leadId, orgId: org.id });
    // Simulate a retry after the job crashed before the status update.
    await t.db.query("update public.leads set status = 'new' where id = $1", [leadId]);
    const second = deps("lead");
    expect(await processLead(second.deps, { leadId, orgId: org.id })).toBe("draft_exists");
    expect(second.api.requests.map((r) => r.body.model)).toEqual(["claude-sonnet-5-5"]);
    expect((await leadState(leadId)).drafts).toHaveLength(1);
  });

  it("marks spam as lost without drafting", async () => {
    const leadId = await insertLead(t.db, org.id, { message: "We offer SEO services, top Google rank!" });
    const { api, deps: d } = deps("spam");
    expect(await processLead(d, { leadId, orgId: org.id })).toBe("spam");
    expect((await leadState(leadId)).lead).toEqual({ status: "lost", classification: "spam" });
    expect(api.requests).toHaveLength(1);
    expect(queue.jobs).toHaveLength(0);
  });

  it("support questions are flagged for the owner without an AI reply", async () => {
    const leadId = await insertLead(t.db, org.id, { message: "Can I move my appointment on Friday?" });
    const { deps: d } = deps("support");
    expect(await processLead(d, { leadId, orgId: org.id })).toBe("support");
    expect((await leadState(leadId)).drafts).toHaveLength(0);
    expect(queue.ofType("notify_support_question")).toHaveLength(1);
  });

  it("records ai_blocked and does not retry when the cap is reached", async () => {
    const capped = (await createOrgFixture(t.db, { plan: "starter" })).org;
    await t.db.query("insert into public.llm_usage (org_id, model, cost_usd) values ($1, 'm', 999)", [capped.id]);
    const leadId = await insertLead(t.db, capped.id);
    const { api, deps: d } = deps("lead");
    expect(await processLead(d, { leadId, orgId: capped.id })).toBe("blocked");
    expect(api.requests).toHaveLength(0);
    const ev = await t.db.query<{ payload: { reason: string } }>(
      "select payload from public.events where lead_id = $1 and type = 'ai_blocked'",
      [leadId],
    );
    expect(ev.rows[0]!.payload.reason).toBe("cap_reached");
  });

  it("ignores leads that were already handled", async () => {
    const leadId = await insertLead(t.db, org.id, { status: "replied" });
    const { api, deps: d } = deps("lead");
    expect(await processLead(d, { leadId, orgId: org.id })).toBe("already_processed");
    expect(api.requests).toHaveLength(0);
  });
});
