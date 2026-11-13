import type { Metadata } from "next";
import Link from "next/link";
import { AuthForm } from "@/components/client/auth-form";
import { logIn } from "../actions";

export const metadata: Metadata = { title: "Log in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <>
      <h1 className="mb-6 text-xl font-semibold">Log in</h1>
      <AuthForm action={logIn} submitLabel="Log in" next={next} passwordAutoComplete="current-password" />
      <p className="mt-6 text-sm text-slate-600">
        New here?{" "}
        <Link href="/signup" className="font-medium text-brand-600 hover:underline">
          Create an account
        </Link>
      </p>
    </>
  );
}
