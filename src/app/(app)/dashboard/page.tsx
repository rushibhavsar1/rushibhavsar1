import type { Metadata } from "next";
import { requireOrgContext } from "@/server/auth/context";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const { org } = await requireOrgContext();
  return (
    <div>
      <h1 className="text-2xl font-semibold">{org.name}</h1>
      <p className="mt-2 text-slate-600">Your dashboard will show leads, reply times, bookings and AI cost.</p>
    </div>
  );
}
