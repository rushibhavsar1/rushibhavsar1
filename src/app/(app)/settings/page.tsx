import type { Metadata } from "next";
import { KnowledgeForm } from "@/components/client/knowledge-form";
import { KNOWLEDGE_FILES } from "@/lib/knowledge";
import { requireOrgContext, withUserDb } from "@/server/auth/context";
import { getKnowledgeFiles } from "@/server/knowledge";
import { saveKnowledge } from "./knowledge-actions";

export const metadata: Metadata = { title: "Knowledge" };

export default async function KnowledgeSettingsPage() {
  const ctx = await requireOrgContext();
  const files = await withUserDb(ctx, (tx) => getKnowledgeFiles(tx, ctx.org.id));
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Knowledge</h1>
        <p className="mt-1 text-sm text-slate-600">
          DeskPilot reads these every time it writes a reply. Keep them up to date — new prices, new FAQs.
        </p>
      </div>
      {KNOWLEDGE_FILES.map((def) => (
        <section key={def.slug} className="card">
          <KnowledgeForm def={def} content={files[def.slug] ?? ""} action={saveKnowledge} submitLabel="Save" compact />
        </section>
      ))}
    </div>
  );
}
