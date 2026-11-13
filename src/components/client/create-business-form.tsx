"use client";

import { useActionState, useSyncExternalStore } from "react";
import { FieldError, FormMessage, SubmitButton } from "@/components/client/form-controls";
import { initialFormState, type FormState } from "@/lib/form";

const subscribe = () => () => {};
const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function CreateBusinessForm({ action }: { action: (prev: FormState, fd: FormData) => Promise<FormState> }) {
  const [state, formAction] = useActionState(action, initialFormState);
  const timezone = useSyncExternalStore(subscribe, browserTimeZone, () => "UTC");
  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label htmlFor="name" className="label">
          Business name
        </label>
        <input id="name" name="name" required maxLength={120} className="input" placeholder="Bright Smile Dental" />
        <FieldError state={state} name="name" />
      </div>
      <div>
        <label htmlFor="timezone" className="label">
          Time zone
        </label>
        <input id="timezone" name="timezone" key={timezone} defaultValue={timezone} className="input" />
        <FieldError state={state} name="timezone" />
      </div>
      <FormMessage state={state} />
      <SubmitButton pendingText="Creating…" className="btn-primary w-full">
        Create business
      </SubmitButton>
    </form>
  );
}
