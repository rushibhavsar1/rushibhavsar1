"use client";

import { useActionState } from "react";
import { FieldError, FormMessage, SubmitButton } from "@/components/client/form-controls";
import { initialFormState, type FormState } from "@/lib/form";
import type { KnowledgeFileDef } from "@/lib/knowledge";

export function KnowledgeForm({
  def,
  content,
  action,
  step,
  submitLabel,
  compact = false,
}: {
  def: KnowledgeFileDef;
  content: string;
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  step?: number;
  submitLabel: string;
  compact?: boolean;
}) {
  const [state, formAction] = useActionState(action, initialFormState);
  const id = `kf-${def.slug}`;
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="slug" value={def.slug} />
      {step ? <input type="hidden" name="step" value={step} /> : null}
      <div>
        <label htmlFor={id} className={compact ? "label" : "text-lg font-semibold text-slate-900"}>
          {compact ? def.title : def.question}
        </label>
        <p className="mt-1 mb-2 text-sm text-slate-600">{def.help}</p>
        {def.input === "url" ? (
          <input
            id={id}
            name="content"
            type="url"
            inputMode="url"
            defaultValue={content}
            placeholder={def.placeholder}
            className="input"
          />
        ) : (
          <textarea
            id={id}
            name="content"
            defaultValue={content}
            placeholder={def.placeholder}
            rows={compact ? 6 : 10}
            className="input font-mono text-[13px]"
          />
        )}
        <FieldError state={state} name="content" />
      </div>
      <FormMessage state={state} />
      <SubmitButton>{submitLabel}</SubmitButton>
    </form>
  );
}
