import type { Metadata } from "next";
import { CopyBox } from "@/components/client/copy-box";
import { appUrl } from "@/lib/urls";
import { requireOrgContext } from "@/server/auth/context";

export const metadata: Metadata = { title: "Website & Cal.com" };

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const { org } = await requireOrgContext();
  const { welcome } = await searchParams;
  const snippet = `<script src="${appUrl("/widget.js")}" data-org="${org.org_key}" async></script>`;
  const endpoint = appUrl(`/api/leads/${org.org_key}`);
  const curl = `curl -X POST ${endpoint} \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Jane","email":"jane@example.com","message":"Do you have time next week?","source":"zapier"}'`;
  const calcomUrl = appUrl(`/api/webhooks/calcom/${org.org_key}`);

  return (
    <div className="space-y-6">
      {welcome ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          You&apos;re set up! Add the contact form to your website below and send yourself a test lead.
        </div>
      ) : null}
      <div>
        <h1 className="text-2xl font-semibold">Website & Cal.com</h1>
        <p className="mt-1 text-sm text-slate-600">Where your leads come from, and how we know they booked.</p>
      </div>

      <section className="card space-y-4">
        <h2 className="text-lg font-semibold">Contact form for your website</h2>
        <p className="text-sm text-slate-600">
          Paste this where the form should appear (WordPress, Wix, Squarespace and Webflow all support an HTML/embed
          block).
        </p>
        <CopyBox value={snippet} />
        <p className="text-xs text-slate-500">
          Options: <code>data-title</code>, <code>data-button</code>, <code>data-color</code>,{" "}
          <code>data-phone=&quot;false&quot;</code>, <code>data-target=&quot;#contact&quot;</code>.
        </p>
      </section>

      <section className="card space-y-4">
        <h2 className="text-lg font-semibold">Webhook (Zapier, Make, your own forms)</h2>
        <p className="text-sm text-slate-600">
          Send leads from anywhere with a POST request. Fields: <code>email</code> and <code>message</code>{" "}
          (required), <code>name</code>, <code>phone</code>, <code>source</code>.
        </p>
        <CopyBox value={curl} />
      </section>

      <section className="card space-y-4">
        <h2 className="text-lg font-semibold">Cal.com bookings</h2>
        <p className="text-sm text-slate-600">
          In Cal.com go to <strong>Settings → Developer → Webhooks → New</strong>, paste this URL and secret, and
          enable the <strong>Booking created</strong> trigger. When a lead books, DeskPilot marks them as booked and
          stops follow-ups.
        </p>
        <CopyBox label="Subscriber URL" value={calcomUrl} />
        <CopyBox label="Secret" value={org.calcom_webhook_secret} />
      </section>
    </div>
  );
}
