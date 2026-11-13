"use client";

import { useActionState } from "react";
import { FormMessage, SubmitButton } from "@/components/client/form-controls";
import type { FormState } from "@/lib/form";

type LinkState = FormState & { link?: string };

export function TelegramConnect({ action }: { action: (prev: LinkState) => Promise<LinkState> }) {
  const [state, formAction] = useActionState(action, {} as LinkState);
  return (
    <div className="space-y-3">
      <form action={formAction}>
        <SubmitButton pendingText="Creating link…">Connect Telegram</SubmitButton>
      </form>
      <FormMessage state={{ error: state.error }} />
      {state.link ? (
        <div className="rounded-md bg-slate-50 p-4 text-sm">
          <p>
            1. Open this link on the phone where you use Telegram (valid for 30 minutes):{" "}
            <a href={state.link} target="_blank" rel="noreferrer" className="font-medium break-all text-brand-600">
              {state.link}
            </a>
          </p>
          <p className="mt-2">2. Tap <strong>Start</strong>. Then reload this page.</p>
        </div>
      ) : null}
    </div>
  );
}

export function TelegramTest({ action }: { action: (prev: FormState) => Promise<FormState> }) {
  const [state, formAction] = useActionState(action, {} as FormState);
  return (
    <form action={formAction} className="space-y-2">
      <SubmitButton className="btn-secondary" pendingText="Sending…">
        Send test message
      </SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}
