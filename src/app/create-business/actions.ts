"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { formDataToObject, zodFieldErrors, type FormState } from "@/lib/form";
import { logger } from "@/lib/logger";
import { requireUser } from "@/server/auth/context";
import { AlreadyHasOrganizationError, createOrganization, createOrganizationInput } from "@/server/orgs";

export async function createBusiness(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const parsed = createOrganizationInput.safeParse(formDataToObject(formData));
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error) };
  try {
    await createOrganization(getDb(), user.id, parsed.data);
  } catch (err) {
    if (err instanceof AlreadyHasOrganizationError) redirect("/dashboard");
    logger.error("create business failed", { err, userId: user.id });
    return { error: "Could not create your business. Please try again." };
  }
  redirect("/onboarding");
}
