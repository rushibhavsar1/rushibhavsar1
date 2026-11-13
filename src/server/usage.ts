import { monthlySpendUsd } from "@/lib/ai";
import type { Db } from "@/lib/db";
import { countLeadsThisMonth } from "@/server/leads/intake";

/** This month's lead count and AI spend (UTC calendar month). */
export async function monthlyUsage(db: Db, orgId: string): Promise<{ leads: number; aiUsd: number }> {
  const [leads, aiUsd] = await Promise.all([countLeadsThisMonth(db, orgId), monthlySpendUsd(db, orgId)]);
  return { leads, aiUsd };
}
