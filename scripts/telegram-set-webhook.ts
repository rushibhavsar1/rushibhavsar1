/**
 * Registers the Telegram webhook: `npm run telegram:set-webhook`.
 * Needs APP_URL (public https URL), TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET.
 */
async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const appUrl = process.env.APP_URL?.replace(/\/+$/, "");
  if (!token || !secret || !appUrl) throw new Error("Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and APP_URL.");
  if (!appUrl.startsWith("https://")) throw new Error("Telegram webhooks need a public https:// APP_URL.");
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET may only contain A-Z, a-z, 0-9, _ and - (max 256).");
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: `${appUrl}/api/webhooks/telegram`,
      secret_token: secret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    }),
  });
  const data = (await res.json()) as { ok: boolean; description?: string };
  if (!data.ok) throw new Error(`setWebhook failed: ${data.description}`);
  console.log(`Webhook set to ${appUrl}/api/webhooks/telegram`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
