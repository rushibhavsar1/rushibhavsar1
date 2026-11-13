"use client";

import { useActionState } from "react";
import { FieldError, FormMessage, SubmitButton } from "@/components/client/form-controls";
import { initialFormState, type FormState } from "@/lib/form";

interface Values {
  sending_domain: string;
  from_local_part: string;
  from_name: string;
  reply_to_email: string;
}

export function EmailSettingsForm({
  values,
  action,
}: {
  values: Values;
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
}) {
  const [state, formAction] = useActionState(action, initialFormState);
  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <label htmlFor="sending_domain" className="label">
          Sending domain
        </label>
        <input
          id="sending_domain"
          name="sending_domain"
          defaultValue={values.sending_domain}
          placeholder="mail.yourbusiness.com"
          className="input"
          required
        />
        <p className="mt-1 text-xs text-slate-500">
          A subdomain such as <code>mail.yourbusiness.com</code> is recommended — it keeps your main domain&apos;s
          email settings untouched.
        </p>
        <FieldError state={state} name="sending_domain" />
      </div>
      <div>
        <label htmlFor="from_local_part" className="label">
          From address (before the @)
        </label>
        <input id="from_local_part" name="from_local_part" defaultValue={values.from_local_part} className="input" />
        <FieldError state={state} name="from_local_part" />
      </div>
      <div>
        <label htmlFor="from_name" className="label">
          From name
        </label>
        <input id="from_name" name="from_name" defaultValue={values.from_name} placeholder="Maria at Bright Smile" className="input" />
        <FieldError state={state} name="from_name" />
      </div>
      <div className="sm:col-span-2">
        <label htmlFor="reply_to_email" className="label">
          Replies go to
        </label>
        <input
          id="reply_to_email"
          name="reply_to_email"
          type="email"
          defaultValue={values.reply_to_email}
          placeholder="you@yourbusiness.com (defaults to your login email)"
          className="input"
        />
        <FieldError state={state} name="reply_to_email" />
      </div>
      <div className="space-y-2 sm:col-span-2">
        <FormMessage state={state} />
        <SubmitButton>Save</SubmitButton>
      </div>
    </form>
  );
}

export function CheckDomainButton({ action }: { action: (prev: FormState) => Promise<FormState> }) {
  const [state, formAction] = useActionState(action, initialFormState);
  return (
    <form action={formAction} className="space-y-2">
      <SubmitButton className="btn-secondary" pendingText="Checking…">
        Check verification
      </SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}
