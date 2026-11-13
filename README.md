# DeskPilot

AI sales desk for small businesses: every new lead gets a personal reply in under
2 minutes — written in the owner's voice, **approved by the owner**, then sent from
their own domain — with a booking link and automatic day 2 / day 5 follow-ups.

- Product scope and rules: [`CLAUDE.md`](CLAUDE.md)
- Build phases: [`docs/BUILD_PROMPTS.md`](docs/BUILD_PROMPTS.md)
- Deploying on a VPS with Coolify: [`docs/DEPLOY.md`](docs/DEPLOY.md)

## How it works

```
Website widget / webhook ──► POST /api/leads/:orgKey ──► leads + process_lead job
                                                              │
                                worker ◄──────────────────────┘
                                  │ classify (claude-haiku-5-5): lead / support / spam
                                  │ draft reply (claude-sonnet-5-5) using knowledge files
                                  ▼
                       draft = pending_approval ──► web inbox + Telegram (Approve / Edit / Reject)
                                                              │ approve
                                                              ▼
                                         send_draft ──► Resend (org's verified domain)
                                                              │
                                     followup_due (day 2, day 5) ──► new drafts, also need approval
                                                              │
                 Cal.com webhook (booking) / lead writes back ──► stop follow-ups
```

Every Monday at 8:00 (each business's local time) owners get a one-page weekly report.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | start the web app |
| `npm run worker` | start the background worker |
| `npm run test` | run tests |
| `npm run typecheck` | run the TypeScript checker |
| `npm run db:migrate` | apply Supabase migrations |
| `npm run lint` | ESLint |
| `npm run check` | everything CI runs: typecheck, lint, tests, web + worker builds |
| `npm run telegram:set-webhook` | register the Telegram webhook (needs a public https `APP_URL`) |

## Local development

1. Node 22.12+ and a Supabase project (or the local stack: `npx supabase start`, then use its
   `postgresql://postgres:postgres@127.0.0.1:54322/postgres` as `DATABASE_URL`).
2. `cp .env.example .env.local` and fill in at least the Supabase values, `DATABASE_URL` and `ANTHROPIC_API_KEY`.
3. `npm ci && npm run db:migrate`
4. Run `npm run dev` and `npm run worker` in two terminals, open http://localhost:3000, sign up.
5. To test the AI without paying via Stripe, mark your org as paid in SQL:
   `update organizations set plan = 'starter', subscription_status = 'active' where name = '…';`

The test suite needs no external services: it runs real Postgres in-process (PGlite),
applies the migrations, and mocks Anthropic (at the HTTP layer), Resend, Telegram and Stripe.

## Code map

| Path | What lives there |
| --- | --- |
| `supabase/migrations/` | Schema + Row Level Security (every table has `org_id`; users can only read their own org) |
| `src/lib/ai.ts` | **The only module that calls Anthropic.** Billing + monthly cap check, prompt caching, usage/cost logging, untrusted-input handling |
| `src/lib/db.ts` | Postgres access; `asUser()` runs queries under RLS as the signed-in user |
| `src/lib/queue.ts` | pg-boss job names and payloads |
| `src/server/` | Business logic: intake, approvals, lead lifecycle, billing, stats, Telegram, webhooks |
| `src/server/jobs/` | Worker jobs: `process-lead`, `notify`, `send-draft`, `followup`, `weekly-report` |
| `src/worker/` | Worker process entry point and job → handler map |
| `src/app/` | Next.js pages, server actions and API routes |
| `public/widget.js` | Embeddable contact form (shadow DOM, no dependencies) |
| `tests/` | Vitest suites (one per feature) and fakes |

## Safety rules (enforced in code)

- **Nothing is sent without approval.** Only `approveDraft()` enqueues sending, `send_draft` refuses anything not
  `approved`, and `organizations.auto_send_enabled` is pinned to `false` by a database constraint.
- **One Anthropic module.** ESLint forbids importing `@anthropic-ai/sdk` outside `src/lib/ai.ts`.
- **Lead text is untrusted.** It is JSON-encoded inside a `<lead>` block with `<`/`>` escaped, the system prompt says
  it is data, and drafts are checked for banned words and unexpected links before the owner sees them.
- **Secrets stay on the server.** No secret has a `NEXT_PUBLIC_` prefix; client components can't import server modules.
- **Every input is validated with Zod; every webhook is verified** (Stripe signature, Cal.com HMAC per org,
  Telegram secret token) and deduplicated.
