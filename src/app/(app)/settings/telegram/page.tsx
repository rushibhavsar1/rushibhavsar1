import type { Metadata } from "next";
import { TelegramConnect, TelegramTest } from "@/components/client/telegram-connect";
import { requireOrgContext } from "@/server/auth/context";
import { connectTelegram, disconnectTelegram, sendTelegramTest } from "./actions";

export const metadata: Metadata = { title: "Telegram" };

export default async function TelegramSettingsPage() {
  const { org } = await requireOrgContext();
  const connected = Boolean(org.telegram_chat_id);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Telegram</h1>
        <p className="mt-1 text-sm text-slate-600">
          Get every draft on your phone and approve, edit or reject it with one tap.
        </p>
      </div>
      <section className="card space-y-4">
        {connected ? (
          <>
            <p className="text-sm">
              <span className="font-medium text-emerald-700">● Connected.</span> Drafts are sent to your Telegram chat.
            </p>
            <div className="flex flex-wrap items-start gap-3">
              <TelegramTest action={sendTelegramTest} />
              <form action={disconnectTelegram}>
                <button type="submit" className="btn-danger">
                  Disconnect
                </button>
              </form>
            </div>
          </>
        ) : (
          <TelegramConnect action={connectTelegram} />
        )}
      </section>
    </div>
  );
}
