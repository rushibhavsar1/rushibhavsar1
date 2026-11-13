import type { Metadata } from "next";
import Link from "next/link";
import { AuthForm } from "@/components/client/auth-form";
import { signUp } from "../actions";

export const metadata: Metadata = { title: "Sign up" };

export default function SignupPage() {
  return (
    <>
      <h1 className="mb-6 text-xl font-semibold">Create your account</h1>
      <AuthForm action={signUp} submitLabel="Sign up" passwordAutoComplete="new-password" />
      <p className="mt-6 text-sm text-slate-600">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-brand-600 hover:underline">
          Log in
        </Link>
      </p>
    </>
  );
}
