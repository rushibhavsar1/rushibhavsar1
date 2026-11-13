import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16">
      <p className="text-sm font-semibold tracking-wide text-brand-600 uppercase">DeskPilot</p>
      <h1 className="mt-3 text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">
        Answer every lead in under 2 minutes.
      </h1>
      <p className="mt-5 text-lg text-slate-600">
        DeskPilot drafts a personal reply to every new enquiry in your own voice, with your prices and your booking
        link. You approve it from your phone, it goes out from your domain, and follow-ups happen on their own until
        the call is booked.
      </p>
      <div className="mt-8 flex gap-3">
        <Link href="/signup" className="btn-primary">
          Start free trial
        </Link>
        <Link href="/login" className="btn-secondary">
          Log in
        </Link>
      </div>
      <ul className="mt-12 grid gap-4 text-sm text-slate-700 sm:grid-cols-3">
        <li className="card">
          <strong className="block text-slate-900">Your voice</strong>
          Replies use your tone, services, prices and FAQs.
        </li>
        <li className="card">
          <strong className="block text-slate-900">You approve</strong>
          Nothing is sent without your OK — on the web or in Telegram.
        </li>
        <li className="card">
          <strong className="block text-slate-900">Follow-ups</strong>
          Day 2 and day 5 nudges stop as soon as they book.
        </li>
      </ul>
    </main>
  );
}
