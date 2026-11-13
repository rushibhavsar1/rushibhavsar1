import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { escapeHtml, verifyTelegramSecret } from "@/lib/telegram";
import { handleTelegramWebhookRequest } from "@/server/telegram/endpoint";
import { createLinkCode } from "@/server/telegram/link";
import { handleTelegramUpdate } from "@/server/telegram/webhook";
import type { Organization } from "@/server/types";
import { createTestDb, type TestDatabase } from "./helpers/db";
import { FakeQueue, FakeTelegram } from "./helpers/fakes";
import { createOrgFixture, insertDraft, insertLead } from "./helpers/fixtures";

const CHAT = 4242;
let updateId = 1;

function message(text: string, opts: { chatId?: number; chatType?: string; replyTo?: string } = {}) {
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      chat: { id: opts.chatId ?? CHAT, type: opts.chatType ?? "private" },
      text,
      ...(opts.replyTo ? { reply_to_message: { message_id: 1, text: opts.replyTo } } : {}),
    },
  };
}

function callback(data: string, chatId = CHAT) {
  return {
    update_id: updateId++,
    callback_query: {
      id: `cb${updateId}`,
      data,
      message: { message_id: 77, chat: { id: chatId, type: "private" }, text: "Draft reply…" },
    },
  };
}

describe("Telegram bot", () => {
  let t: TestDatabase;
  let org: Organization;
  const queue = new FakeQueue();
  const telegram = new FakeTelegram();
  const deps = () => ({ db: t.db, queue, telegram });

  beforeAll(async () => {
    t = await createTestDb();
    org = (await createOrgFixture(t.db, { name: "Bright <Smile>" })).org;
  });
  afterAll(() => t.close());
  beforeEach(() => {
    queue.clear();
    telegram.clear();
  });

  async function chatOf(orgId: string) {
    const { rows } = await t.db.query<{ c: string | null }>(
      "select telegram_chat_id::text as c from public.organizations where id = $1",
      [orgId],
    );
    return rows[0]!.c;
  }

  it("links the owner's private chat with a one-time code", async () => {
    const code = await createLinkCode(t.db, org.id);
    expect(await handleTelegramUpdate(deps(), message(`/start ${code}`, { chatType: "group" }))).toBe("not_private");
    expect(await handleTelegramUpdate(deps(), message(`/start ${code}`))).toBe("linked");
    expect(await chatOf(org.id)).toBe(String(CHAT));
    expect(telegram.sent().at(-1)!.text).toContain(escapeHtml("Bright <Smile>"));
    // Codes are single-use.
    expect(await handleTelegramUpdate(deps(), message(`/start ${code}`, { chatId: 999 }))).toBe("invalid_code");
  });

  it("rejects expired codes", async () => {
    const other = (await createOrgFixture(t.db)).org;
    const code = await createLinkCode(t.db, other.id);
    await t.db.query("update public.organizations set telegram_link_expires_at = now() - interval '1 minute' where id = $1", [
      other.id,
    ]);
    expect(await handleTelegramUpdate(deps(), message(`/start ${code}`, { chatId: 31337 }))).toBe("invalid_code");
    expect(await chatOf(other.id)).toBeNull();
  });

  it("approves a draft with the button and enqueues sending", async () => {
    const draftId = await insertDraft(t.db, org.id, await insertLead(t.db, org.id));
    expect(await handleTelegramUpdate(deps(), callback(`a:${draftId}`))).toBe("approved");
    const { rows } = await t.db.query<{ status: string; approved_via: string }>(
      "select status, approved_via from public.drafts where id = $1",
      [draftId],
    );
    expect(rows[0]).toEqual({ status: "approved", approved_via: "telegram" });
    expect(queue.ofType("send_draft")).toHaveLength(1);
    expect(telegram.calls.find((c) => c.method === "edit")?.text).toContain("Approved");
  });

  it("ignores buttons pressed in a chat that is not linked to the draft's business", async () => {
    const draftId = await insertDraft(t.db, org.id, await insertLead(t.db, org.id));
    expect(await handleTelegramUpdate(deps(), callback(`a:${draftId}`, 666))).toBe("forbidden");
    const { rows } = await t.db.query<{ status: string }>("select status from public.drafts where id = $1", [draftId]);
    expect(rows[0]!.status).toBe("pending_approval");
    expect(queue.jobs).toHaveLength(0);
  });

  it("rejects a draft", async () => {
    const draftId = await insertDraft(t.db, org.id, await insertLead(t.db, org.id));
    expect(await handleTelegramUpdate(deps(), callback(`r:${draftId}`))).toBe("rejected");
    expect(await handleTelegramUpdate(deps(), callback(`r:${draftId}`))).toBe("not_pending");
  });

  it("edits a draft by replying with new text", async () => {
    const draftId = await insertDraft(t.db, org.id, await insertLead(t.db, org.id));
    expect(await handleTelegramUpdate(deps(), callback(`e:${draftId}`))).toBe("edit_prompted");
    const prompt = telegram.sent().at(-1)!;
    expect(prompt.forceReply).toBe(true);
    expect(prompt.text).toContain(`ref:${draftId}`);

    const result = await handleTelegramUpdate(
      deps(),
      message("Hi Jane — new text. Book: https://cal.com/brightsmile/intro", { replyTo: prompt.text }),
    );
    expect(result).toBe("edited");
    const { rows } = await t.db.query<{ body: string; status: string }>(
      "select body, status from public.drafts where id = $1",
      [draftId],
    );
    expect(rows[0]).toEqual({ body: "Hi Jane — new text. Book: https://cal.com/brightsmile/intro", status: "pending_approval" });
    // A fresh preview with buttons follows.
    expect(telegram.sent().at(-1)!.buttons?.[0]?.[0]?.callback_data).toBe(`a:${draftId}`);
  });

  it("stops follow-ups from a follow-up draft", async () => {
    const leadId = await insertLead(t.db, org.id, { status: "replied" });
    const draftId = await insertDraft(t.db, org.id, leadId, { kind: "followup_1" });
    expect(await handleTelegramUpdate(deps(), callback(`s:${draftId}`))).toBe("stopped");
    const { rows } = await t.db.query<{ status: string }>("select status from public.drafts where id = $1", [draftId]);
    expect(rows[0]!.status).toBe("cancelled");
  });

  it("verifies the webhook secret header", async () => {
    expect(verifyTelegramSecret("abc", "abc")).toBe(true);
    expect(verifyTelegramSecret("abd", "abc")).toBe(false);
    expect(verifyTelegramSecret(null, "abc")).toBe(false);
    expect(verifyTelegramSecret("abc", undefined)).toBe(false);

    const req = (secret?: string) =>
      new Request("http://localhost/api/webhooks/telegram", {
        method: "POST",
        headers: secret ? { "x-telegram-bot-api-secret-token": secret } : {},
        body: JSON.stringify(message("/start")),
      });
    const d = { ...deps(), secret: "s3cret" };
    expect((await handleTelegramWebhookRequest(req(), d)).status).toBe(401);
    expect((await handleTelegramWebhookRequest(req("wrong"), d)).status).toBe(401);
    expect((await handleTelegramWebhookRequest(req("s3cret"), d)).status).toBe(200);
    expect(telegram.sent().at(-1)!.text).toContain("DeskPilot bot");
  });
});
