"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { mailerFromEnv } from "@/lib/email";
import { formDataToObject, zodFieldErrors, type FormState } from "@/lib/form";
import { logger } from "@/lib/logger";
import { getQueue } from "@/lib/queue";
import { requireOrgAdmin } from "@/server/auth/context";
import { EmailSettingsError, refreshDomainStatus, saveSendingSettings, sendingSettingsInput } from "@/server/email/settings";

export async function saveEmailSettings(_prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await requireOrgAdmin();
  const raw = formDataToObject(formData);
  const parsed = sendingSettingsInput.safeParse(raw);
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error) };
  try {
    await saveSendingSettings(getDb(), mailerFromEnv(), ctx.org, {
      sending_domain: raw.sending_domain ?? "",
      from_local_part: raw.from_local_part ?? "",
      from_name: raw.from_name,
      reply_to_email: raw.reply_to_email,
    });
  } catch (err) {
    if (err instanceof EmailSettingsError) return { error: err.message };
    logger.error("save email settings failed", { err, orgId: ctx.org.id });
    return { error: "Could not save. Please try again." };
  }
  revalidatePath("/settings/email");
  return { ok: true, message: "Saved. Add the DNS records below, then click “Check verification”." };
}

export async function checkDomain(_prev: FormState): Promise<FormState> {
  const ctx = await requireOrgAdmin();
  const mailer = mailerFromEnv();
  if (!mailer) return { error: "Email sending is not configured on this server." };
  try {
    const info = await refreshDomainStatus({ db: getDb(), mailer, queue: getQueue() }, ctx.org);
    revalidatePath("/settings/email");
    if (!info) return { error: "Save a sending domain first." };
    return info.status === "verified"
      ? { ok: true, message: "Verified! Emails will now go out from your domain." }
      : { ok: true, message: "Not verified yet. DNS changes can take up to a few hours." };
  } catch (err) {
    logger.error("domain check failed", { err, orgId: ctx.org.id });
    return { error: "Could not reach Resend. Please try again." };
  }
}
