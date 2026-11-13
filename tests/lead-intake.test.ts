import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleLeadOptions, handleLeadPost, LIMITS } from "@/server/http/lead-endpoint";
import { clientIp } from "@/server/http/request";
import { hitRateLimit } from "@/server/rate-limit";
import type { Organization } from "@/server/types";
import { createTestDb, type TestDatabase } from "./helpers/db";
import { FakeQueue } from "./helpers/fakes";
import { createOrgFixture } from "./helpers/fixtures";

let ipCounter = 0;
function post(orgKey: string, body: unknown, opts: { ip?: string; contentType?: string } = {}) {
  ipCounter += 1;
  return new Request(`http://localhost/api/leads/${orgKey}`, {
    method: "POST",
    headers: {
      "content-type": opts.contentType ?? "application/json",
      "x-forwarded-for": opts.ip ?? `10.0.0.${ipCounter}`,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/leads/:orgKey", () => {
  let t: TestDatabase;
  let org: Organization;
  let unpaid: Organization;
  const queue = new FakeQueue();

  beforeAll(async () => {
    t = await createTestDb();
    org = (await createOrgFixture(t.db)).org;
    unpaid = (await createOrgFixture(t.db, { plan: "none", status: "none" })).org;
  });
  afterAll(() => t.close());
  beforeEach(() => queue.clear());

  const deps = () => ({ db: t.db, queue });

  it("saves a valid lead and enqueues process_lead", async () => {
    const res = await handleLeadPost(
      post(org.org_key, { name: "Jane", email: "Jane@Example.com", message: "Do you do whitening?" }),
      org.org_key,
      deps(),
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");

    const { rows } = await t.db.query<{ id: string; email: string; status: string; source: string }>(
      "select id, email, status, source from public.leads where org_id = $1",
      [org.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "jane@example.com", status: "new", source: "form" });
    expect(queue.ofType("process_lead")).toEqual([
      expect.objectContaining({ data: { leadId: rows[0]!.id, orgId: org.id } }),
    ]);
  });

  it("accepts form-encoded bodies (simple webhooks)", async () => {
    const res = await handleLeadPost(
      post(org.org_key, "email=bob%40example.com&message=Hello&source=zapier", {
        contentType: "application/x-www-form-urlencoded",
      }),
      org.org_key,
      deps(),
    );
    expect(res.status).toBe(201);
  });

  it("validates input with Zod", async () => {
    const res = await handleLeadPost(post(org.org_key, { email: "not-an-email", message: "" }), org.org_key, deps());
    expect(res.status).toBe(422);
    const body = (await res.json()) as { fields: Record<string, string> };
    expect(Object.keys(body.fields)).toEqual(expect.arrayContaining(["email", "message"]));
    expect(queue.jobs).toHaveLength(0);
  });

  it("rejects unknown org keys and oversized or malformed bodies", async () => {
    expect((await handleLeadPost(post("nope", {}), "nope", deps())).status).toBe(404);
    const unknownKey = "0".repeat(32);
    expect(
      (await handleLeadPost(post(unknownKey, { email: "a@b.co", message: "x" }), unknownKey, deps())).status,
    ).toBe(404);
    expect((await handleLeadPost(post(org.org_key, "{not json"), org.org_key, deps())).status).toBe(400);
    const big = { email: "a@b.co", message: "x".repeat(20_000) };
    expect((await handleLeadPost(post(org.org_key, big), org.org_key, deps())).status).toBe(413);
  });

  it("silently drops honeypot submissions", async () => {
    const before = await t.db.query<{ n: number }>("select count(*)::int as n from public.leads");
    const res = await handleLeadPost(
      post(org.org_key, { email: "bot@spam.com", message: "buy now", website: "http://spam" }),
      org.org_key,
      deps(),
    );
    expect(res.status).toBe(200);
    const after = await t.db.query<{ n: number }>("select count(*)::int as n from public.leads");
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    expect(queue.jobs).toHaveLength(0);
  });

  it("rate limits by IP", async () => {
    const ip = "203.0.113.9";
    const statuses: number[] = [];
    for (let i = 0; i < LIMITS.perIp.limit + 1; i++) {
      const res = await handleLeadPost(
        post(org.org_key, { email: `p${i}@example.com`, message: "hi" }, { ip }),
        org.org_key,
        deps(),
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, LIMITS.perIp.limit).every((s) => s === 201)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("can't dodge the IP limit by spoofing X-Forwarded-For", async () => {
    // Our proxy appends the real client IP last; the client controls what comes before it.
    const statuses: number[] = [];
    for (let i = 0; i < LIMITS.perIp.limit + 1; i++) {
      const res = await handleLeadPost(
        post(org.org_key, { email: `s${i}@example.com`, message: "hi" }, { ip: `10.9.9.${i}, 198.51.100.200` }),
        org.org_key,
        deps(),
      );
      statuses.push(res.status);
    }
    expect(statuses.at(-1)).toBe(429);
  });

  it("stores leads for unpaid orgs but does not run AI", async () => {
    const res = await handleLeadPost(
      post(unpaid.org_key, { email: "x@example.com", message: "Hello" }),
      unpaid.org_key,
      deps(),
    );
    expect(res.status).toBe(201);
    expect(queue.jobs).toHaveLength(0);
    const ev = await t.db.query<{ payload: { reason: string } }>(
      "select payload from public.events where org_id = $1 and type = 'ai_skipped'",
      [unpaid.id],
    );
    expect(ev.rows[0]?.payload.reason).toBe("unpaid");
  });

  it("a returning lead counts as a response and stops follow-ups on the old conversation", async () => {
    const { rows } = await t.db.query<{ id: string }>(
      `insert into public.leads (org_id, email, message, status) values ($1, 'repeat@example.com', 'first', 'replied')
       returning id`,
      [org.id],
    );
    const oldLead = rows[0]!.id;
    await t.db.query(
      `insert into public.drafts (lead_id, org_id, kind, body, status) values ($1, $2, 'followup_1', 'nudge', 'pending_approval')`,
      [oldLead, org.id],
    );
    const res = await handleLeadPost(
      post(org.org_key, { email: "REPEAT@example.com", message: "Actually, one more question" }),
      org.org_key,
      deps(),
    );
    expect(res.status).toBe(201);
    const lead = await t.db.query<{ lead_responded_at: Date | null; followups_stopped_at: Date | null }>(
      "select lead_responded_at, followups_stopped_at from public.leads where id = $1",
      [oldLead],
    );
    expect(lead.rows[0]!.lead_responded_at).toBeInstanceOf(Date);
    expect(lead.rows[0]!.followups_stopped_at).toBeInstanceOf(Date);
    const draft = await t.db.query<{ status: string }>("select status from public.drafts where lead_id = $1", [
      oldLead,
    ]);
    expect(draft.rows[0]!.status).toBe("cancelled");
  });

  it("answers CORS preflight", () => {
    const res = handleLeadOptions();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });
});

describe("clientIp", () => {
  const req = (xff: string) => new Request("http://x", { headers: { "x-forwarded-for": xff } });
  it("trusts only the entry added by our own proxies", () => {
    expect(clientIp(req("6.6.6.6, 203.0.113.5"), 1)).toBe("203.0.113.5");
    expect(clientIp(req("6.6.6.6, 203.0.113.5, 10.0.0.2"), 2)).toBe("203.0.113.5");
    expect(clientIp(req("203.0.113.5"), 2)).toBe("203.0.113.5");
    expect(clientIp(new Request("http://x", { headers: { "x-real-ip": "203.0.113.7" } }), 1)).toBe("203.0.113.7");
  });
});

describe("hitRateLimit", () => {
  it("counts within a fixed window and resets in the next", async () => {
    const t = await createTestDb();
    const now = new Date("2026-01-01T00:00:10Z");
    expect((await hitRateLimit(t.db, "k", 2, 60, now)).allowed).toBe(true);
    expect((await hitRateLimit(t.db, "k", 2, 60, now)).allowed).toBe(true);
    expect((await hitRateLimit(t.db, "k", 2, 60, now)).allowed).toBe(false);
    expect((await hitRateLimit(t.db, "k", 2, 60, new Date("2026-01-01T00:01:10Z"))).allowed).toBe(true);
    await t.close();
  });
});
