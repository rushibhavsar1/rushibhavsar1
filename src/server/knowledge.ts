import type { Db } from "@/lib/db";
import { isKnowledgeSlug, parseKnowledgeContent, type KnowledgeSlug } from "@/lib/knowledge";
import { recordEvent } from "@/server/events";

export type KnowledgeMap = Partial<Record<KnowledgeSlug, string>>;

export async function getKnowledgeFiles(db: Db, orgId: string): Promise<KnowledgeMap> {
  const { rows } = await db.query<{ slug: string; content: string }>(
    "select slug, content from public.knowledge_files where org_id = $1 order by slug",
    [orgId],
  );
  const out: KnowledgeMap = {};
  for (const row of rows) {
    if (isKnowledgeSlug(row.slug)) out[row.slug] = row.content;
  }
  return out;
}

export class KnowledgeValidationError extends Error {}

/** Validates, normalizes and saves one knowledge file. Returns the saved content. */
export async function saveKnowledgeFile(
  db: Db,
  orgId: string,
  slug: KnowledgeSlug,
  raw: string,
  opts: { requireFilled?: boolean; userId?: string } = {},
): Promise<string> {
  const parsed = parseKnowledgeContent(slug, raw, opts);
  if (!parsed.ok) throw new KnowledgeValidationError(parsed.error);
  await db.query(
    `insert into public.knowledge_files (org_id, slug, content) values ($1, $2, $3)
     on conflict (org_id, slug) do update set content = excluded.content`,
    [orgId, slug, parsed.content],
  );
  await recordEvent(db, orgId, "knowledge_file_saved", { slug, by: opts.userId ?? null });
  return parsed.content;
}

export async function completeOnboarding(db: Db, orgId: string): Promise<void> {
  await db.query(
    "update public.organizations set onboarding_completed_at = coalesce(onboarding_completed_at, now()) where id = $1",
    [orgId],
  );
  await recordEvent(db, orgId, "onboarding_completed");
}
