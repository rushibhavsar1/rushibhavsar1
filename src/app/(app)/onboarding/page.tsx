import type { Metadata } from "next";
import Link from "next/link";
import { KnowledgeForm } from "@/components/client/knowledge-form";
import { KNOWLEDGE_FILES } from "@/lib/knowledge";
import { requireOrgContext, withUserDb } from "@/server/auth/context";
import { getKnowledgeFiles } from "@/server/knowledge";
import { saveOnboardingStep } from "../settings/knowledge-actions";

export const metadata: Metadata = { title: "Set up your business" };

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ step?: string }> }) {
  const ctx = await requireOrgContext();
  const total = KNOWLEDGE_FILES.length;
  const raw = Number((await searchParams).step ?? 1);
  const step = Number.isInteger(raw) && raw >= 1 && raw <= total ? raw : 1;
  const def = KNOWLEDGE_FILES[step - 1]!;
  const files = await withUserDb(ctx, (tx) => getKnowledgeFiles(tx, ctx.org.id));

  return (
    <div className="mx-auto max-w-2xl">
      <p className="text-sm font-medium text-brand-600">
        Step {step} of {total} · {def.title}
      </p>
      <div className="mt-2 mb-6 h-1.5 w-full rounded-full bg-slate-200" aria-hidden>
        <div className="h-1.5 rounded-full bg-brand-600" style={{ width: `${(step / total) * 100}%` }} />
      </div>
      <div className="card">
        <KnowledgeForm
          key={def.slug}
          def={def}
          content={files[def.slug] ?? ""}
          action={saveOnboardingStep}
          step={step}
          submitLabel={step === total ? "Finish setup" : "Save and continue"}
        />
      </div>
      <div className="mt-4 flex justify-between text-sm">
        {step > 1 ? (
          <Link href={`/onboarding?step=${step - 1}`} className="text-slate-600 hover:underline">
            ← Back
          </Link>
        ) : (
          <span />
        )}
        <span className="text-slate-500">You can change all of this later in Settings.</span>
      </div>
    </div>
  );
}
