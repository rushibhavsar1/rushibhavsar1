"use client";

import { useActionState } from "react";
import { FieldError, FormMessage, SubmitButton } from "@/components/client/form-controls";
import { initialFormState, type FormState } from "@/lib/form";

export function DraftEditor({
  draftId,
  subject,
  body,
  action,
}: {
  draftId: string;
  subject: string;
  body: string;
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
}) {
  const [state, formAction] = useActionState(action, initialFormState);
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="draftId" value={draftId} />
      <div>
        <label className="label" htmlFor={`subject-${draftId}`}>
          Subject
        </label>
        <input id={`subject-${draftId}`} name="subject" defaultValue={subject} maxLength={200} className="input" />
        <FieldError state={state} name="subject" />
      </div>
      <div>
        <label className="label" htmlFor={`body-${draftId}`}>
          Email
        </label>
        <textarea id={`body-${draftId}`} name="body" defaultValue={body} rows={12} className="input" />
        <FieldError state={state} name="body" />
      </div>
      <FormMessage state={state} />
      <div className="flex flex-wrap gap-2">
        <SubmitButton name="intent" value="approve" pendingText="Working…">
          Approve &amp; send
        </SubmitButton>
        <SubmitButton name="intent" value="save" className="btn-secondary" pendingText="Working…">
          Save edits
        </SubmitButton>
        <SubmitButton name="intent" value="reject" className="btn-danger" pendingText="Working…">
          Reject
        </SubmitButton>
      </div>
    </form>
  );
}
