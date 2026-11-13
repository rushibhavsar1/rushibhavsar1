import Link from "next/link";
import { logOut } from "@/app/(auth)/actions";
import { requireOrgContext } from "@/server/auth/context";

const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/inbox", label: "Inbox" },
  { href: "/leads", label: "Leads" },
  { href: "/settings", label: "Settings" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { org, user } = await requireOrgContext();
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/dashboard" className="text-sm font-semibold tracking-wide text-brand-600 uppercase">
            DeskPilot
          </Link>
          <nav className="flex flex-wrap gap-4 text-sm">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} className="text-slate-700 hover:text-slate-900">
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm text-slate-600">
            <span className="hidden sm:inline" title={user.email ?? undefined}>
              {org.name}
            </span>
            <form action={logOut}>
              <button type="submit" className="text-slate-500 hover:text-slate-900">
                Log out
              </button>
            </form>
          </div>
        </div>
      </header>
      {!org.onboarding_completed_at ? (
        <div className="border-b border-amber-200 bg-amber-50">
          <div className="mx-auto max-w-6xl px-4 py-2 text-sm text-amber-800">
            Finish setting up your business so DeskPilot can write in your voice.{" "}
            <Link href="/onboarding" className="font-medium underline">
              Continue setup
            </Link>
          </div>
        </div>
      ) : null}
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
