"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import type { FormState } from "@/lib/form";
import { logger } from "@/lib/logger";
import { telegramFromEnv } from "@/lib/telegram";
import { requireOrgAdmin } from "@/server/auth/context";
import { createLinkCode, unlinkTelegram } from "@/server/telegram/link";

export async function connectTelegram(_prev: FormState): Promise<FormState & { link?: string }> {
  const ctx = await requireOrgAdmin();
  const bot = env().TELEGRAM_BOT_USERNAME;
  if (!bot || !telegramFromEnv()) return { error: "Telegram is not configured on this server yet." };
  const code = await createLinkCode(getDb(), ctx.org.id);
  return { ok: true, link: `https://t.me/${bot.replace(/^@/, "")}?start=${code}` };
}

export async function disconnectTelegram(): Promise<void> {
  const ctx = await requireOrgAdmin();
  await unlinkTelegram(getDb(), ctx.org.id);
  revalidatePath("/settings/telegram");
}

export async function sendTelegramTest(_prev: FormState): Promise<FormState> {
  const ctx = await requireOrgAdmin();
  const telegram = telegramFromEnv();
  if (!telegram || !ctx.org.telegram_chat_id) return { error: "Telegram is not connected." };
  try {
    await telegram.sendMessage(ctx.org.telegram_chat_id, "👋 Test from DeskPilot — you're all set.");
    return { ok: true, message: "Sent! Check Telegram." };
  } catch (err) {
    logger.warn("telegram test failed", { err, orgId: ctx.org.id });
    return { error: "Could not reach Telegram. Did you block the bot?" };
  }
}
