import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { asUser, getDb } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getMembershipForUser } from "@/server/orgs";
import type { MemberRole, Organization } from "@/server/types";

export interface OrgContext {
  user: User;
  org: Organization;
  role: MemberRole;
}

/** The signed-in user, verified with Supabase Auth. */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
});

/** The user's organization and role. Membership is read with RLS applied. */
export const getOrgContext = cache(async (): Promise<OrgContext | null> => {
  const user = await getCurrentUser();
  if (!user) return null;
  const membership = await asUser(getDb(), user.id, (tx) => getMembershipForUser(tx, user.id));
  if (!membership) return null;
  return { user, org: membership.org, role: membership.role };
});

export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireOrgContext(): Promise<OrgContext> {
  await requireUser();
  const ctx = await getOrgContext();
  if (!ctx) redirect("/create-business");
  return ctx;
}

/** Settings, billing and integrations are limited to owners and admins. */
export async function requireOrgAdmin(): Promise<OrgContext> {
  const ctx = await requireOrgContext();
  if (ctx.role !== "owner" && ctx.role !== "admin") {
    throw new Error("Only the business owner can change this.");
  }
  return ctx;
}
