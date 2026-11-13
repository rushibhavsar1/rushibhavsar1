import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseKnowledgeContent } from "@/lib/knowledge";
import { createOrganization, getOrganization } from "@/server/orgs";
import { completeOnboarding, getKnowledgeFiles, KnowledgeValidationError, saveKnowledgeFile } from "@/server/knowledge";
import { createTestDb, createUser, type TestDatabase } from "./helpers/db";

describe("knowledge files", () => {
  let t: TestDatabase;
  let orgId: string;

  beforeAll(async () => {
    t = await createTestDb();
    const user = await createUser(t.db, "owner@example.com");
    orgId = (await createOrganization(t.db, user, { name: "Biz" })).id;
  });
  afterAll(() => t.close());

  it("saves each onboarding answer as a knowledge file and updates it later", async () => {
    await saveKnowledgeFile(t.db, orgId, "voice", "  Friendly and short.\r\nSign off: Sam  ");
    await saveKnowledgeFile(t.db, orgId, "booking", "https://cal.com/biz/intro");
    await saveKnowledgeFile(t.db, orgId, "banned_words", "cheap, guarantee\ncheap\n\nASAP");
    await saveKnowledgeFile(t.db, orgId, "voice", "Formal.");

    const files = await getKnowledgeFiles(t.db, orgId);
    expect(files.voice).toBe("Formal.");
    expect(files.booking).toBe("https://cal.com/biz/intro");
    expect(files.banned_words).toBe("cheap\nguarantee\nASAP");
  });

  it("rejects a booking link that is not https", async () => {
    await expect(saveKnowledgeFile(t.db, orgId, "booking", "javascript:alert(1)")).rejects.toBeInstanceOf(
      KnowledgeValidationError,
    );
    expect(parseKnowledgeContent("booking", "http://cal.com/x").ok).toBe(false);
  });

  it("requires the essential files during onboarding", () => {
    expect(parseKnowledgeContent("services", "", { requireFilled: true }).ok).toBe(false);
    expect(parseKnowledgeContent("faqs", "", { requireFilled: true }).ok).toBe(true);
  });

  it("marks onboarding complete", async () => {
    await completeOnboarding(t.db, orgId);
    const org = await getOrganization(t.db, orgId);
    expect(org?.onboarding_completed_at).toBeInstanceOf(Date);
  });
});
