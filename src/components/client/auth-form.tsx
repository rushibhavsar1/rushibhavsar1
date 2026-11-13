"use client";

import { useActionState } from "react";
import { FieldError, FormMessage, SubmitButton } from "@/components/client/form-controls";
import { initialFormState, type FormState } from "@/lib/form";

export function AuthForm({
  action,
  submitLabel,
  next,
  passwordAutoComplete,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  submitLabel: string;
  next?: string;
  passwordAutoComplete: "current-password" | "new-password";
}) {
  const [state, formAction] = useActionState(action, initialFormState);
  return (
    <form action={formAction} className="space-y-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <div>
        <label htmlFor="email" className="label">
          Email
        </label>
        <input id="email" name="email" type="email" autoComplete="email" required className="input" />
        <FieldError state={state} name="email" />
      </div>
      <div>
        <label htmlFor="password" className="label">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete={passwordAutoComplete}
          minLength={8}
          required
          className="input"
        />
        <FieldError state={state} name="password" />
      </div>
      <FormMessage state={state} />
      <SubmitButton pendingText="Please wait…" className="btn-primary w-full">
        {submitLabel}
      </SubmitButton>
    </form>
  );
}
