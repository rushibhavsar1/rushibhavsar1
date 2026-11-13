import Link from "next/link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 py-12">
      <Link href="/" className="mb-8 text-sm font-semibold tracking-wide text-brand-600 uppercase">
        DeskPilot
      </Link>
      <div className="card">{children}</div>
    </main>
  );
}
