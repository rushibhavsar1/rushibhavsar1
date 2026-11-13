import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CreateBusinessForm } from "@/components/client/create-business-form";
import { getOrgContext, requireUser } from "@/server/auth/context";
import { createBusiness } from "./actions";

export const metadata: Metadata = { title: "Create your business" };

export default async function CreateBusinessPage() {
  await requireUser();
  if (await getOrgContext()) redirect("/dashboard");
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <div className="card">
        <h1 className="text-xl font-semibold">Create your business</h1>
        <p className="mt-1 mb-6 text-sm text-slate-600">
          One account = one business. Next, we&apos;ll learn how you talk to customers.
        </p>
        <CreateBusinessForm action={createBusiness} />
      </div>
    </main>
  );
}
