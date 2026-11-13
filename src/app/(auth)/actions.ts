"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { formDataToObject, zodFieldErrors, type FormState } from "@/lib/form";
import { appUrl, safeNextPath } from "@/lib/urls";

const credentials = z.object({
  email: z.email("Enter a valid email address").max(254),
  password: z.string().min(8, "Use at least 8 characters").max(72),
  next: z.string().optional(),
});

export async function logIn(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = credentials.safeParse(formDataToObject(formData));
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error) };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error) return { error: "Wrong email or password." };
  redirect(safeNextPath(parsed.data.next));
}

export async function signUp(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = credentials.safeParse(formDataToObject(formData));
  if (!parsed.success) return { fieldErrors: zodFieldErrors(parsed.error) };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: { emailRedirectTo: appUrl("/auth/callback?next=/create-business") },
  });
  if (error) return { error: error.message };
  if (!data.session) {
    // Email confirmation is enabled in Supabase Auth.
    return { ok: true, message: "Check your inbox and click the link to confirm your email." };
  }
  redirect("/create-business");
}

export async function logOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
