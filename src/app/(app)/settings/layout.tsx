import Link from "next/link";

const TABS = [
  { href: "/settings", label: "Knowledge" },
  { href: "/settings/integrations", label: "Website & Cal.com" },
  { href: "/settings/telegram", label: "Telegram" },
  { href: "/settings/email", label: "Email sending" },
  { href: "/settings/billing", label: "Billing" },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid gap-8 md:grid-cols-[200px_1fr]">
      <nav className="flex flex-row flex-wrap gap-2 md:flex-col" aria-label="Settings">
        {TABS.map((t) => (
          <Link key={t.href} href={t.href} className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100">
            {t.label}
          </Link>
        ))}
      </nav>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
