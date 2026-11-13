"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import type { FormState } from "@/lib/form";
import { isKnowledgeSlug, KNOWLEDGE_FILES } from "@/lib/knowledge";
import { logger } from "@/lib/logger";
import { requireOrgAdmin } from "@/server/auth/context";
import { completeOnboarding, KnowledgeValidationError, saveKnowledgeFile } from "@/server/knowledge";

async function save(formData: FormData, requireFilled: boolean): Promise<FormState & { saved?: boolean }> {
  const ctx = await requireOrgAdmin();
  const slug = String(formData.get("slug") ?? "");
  const content = String(formData.get("content") ?? "");
  if (!isKnowledgeSlug(slug)) return { error: "Unknown knowledge file." };
  try {
    await saveKnowledgeFile(getDb(), ctx.org.id, slug, content, { requireFilled, userId: ctx.user.id });
    return { saved: true };
  } catch (err) {
    if (err instanceof KnowledgeValidationError) return { fieldErrors: { content: err.message } };
    logger.error("save knowledge file failed", { err, orgId: ctx.org.id, slug });
    return { error: "Could not save. Please try again." };
  }
}

/** Onboarding wizard: save the current step, then go to the next one. */
export async function saveOnboardingStep(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await save(formData, true);
  if (!result.saved) return result;
  const step = Number(formData.get("step") ?? 1);
  if (step >= KNOWLEDGE_FILES.length) {
    const ctx = await requireOrgAdmin();
    await completeOnboarding(getDb(), ctx.org.id);
    revalidatePath("/", "layout");
    redirect("/settings/integrations?welcome=1");
  }
  redirect(`/onboarding?step=${step + 1}`);
}

/** Settings page: save one knowledge file. */
export async function saveKnowledge(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await save(formData, false);
  if (!result.saved) return result;
  revalidatePath("/settings");
  return { ok: true, message: "Saved." };
}
