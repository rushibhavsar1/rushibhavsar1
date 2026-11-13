# Build Prompts for Claude Code

How to use:
1. Create an empty folder, put `CLAUDE.md` in it, run `git init`.
2. Open Claude Code in that folder.
3. Paste ONE prompt at a time. Let it finish, test it yourself, commit, then go to the next.
4. Have these accounts ready (all have free tiers to start): Supabase, Anthropic API,
   Resend, Telegram (@BotFather), Cal.com, Stripe (test mode).

---

## Phase 1 - Project setup
Read CLAUDE.md. Set up the Next.js + TypeScript + Tailwind project, Vitest, Zod,
ESLint, and a `.env.example` listing every key we will need. Add the npm scripts
from CLAUDE.md. Do not build features yet. Show me the plan first.

## Phase 2 - Database and auth
Create Supabase migrations for every table in CLAUDE.md with Row Level Security
so users only see their own organization's data. Add sign up, log in, and
"create your business" pages. Write a test that proves org A cannot read org B's leads.

## Phase 3 - Onboarding and knowledge files
Build an onboarding wizard that asks the owner about their tone of voice, services
and prices, common questions, booking link, and words to never use. Save each
answer as a knowledge file. Add a settings page to edit them later.

## Phase 4 - Lead intake
Build `POST /api/leads/:orgKey` with Zod validation and rate limiting, plus a small
embeddable script (`<script src=".../widget.js" data-org="...">`) that shows a
contact form on any website. Save leads and enqueue a `process_lead` job.

## Phase 5 - AI pipeline
Create `src/lib/ai.ts` as the only place that calls the Anthropic API. It must log
tokens and cost to `llm_usage`, use prompt caching for knowledge files, and stop
when the org hits its monthly cap. Then build the worker job: classify the lead
with claude-haiku-5-5, and if it is a real lead, draft a reply with
claude-sonnet-5-5 in the owner's voice. Treat the lead's message as untrusted data.
Add tests with a mocked API.

## Phase 6 - Approval inbox
Build a web inbox showing pending drafts next to the original lead message, with
Approve, Edit, and Reject buttons. Then add a Telegram bot: the owner links their
chat once, gets each draft as a message, and can approve or reject with buttons.
Verify Telegram webhook requests.

## Phase 7 - Sending and follow-ups
On approval, send the email with Resend from the org's verified domain and mark the
lead as replied. Schedule follow-up drafts for day 2 and day 5 (they also need
approval). Cancel follow-ups if the lead replies or books.

## Phase 8 - Bookings
Add a Cal.com webhook (verify the signature) that matches the booking to the lead
by email, marks it "booked", and cancels pending follow-ups.

## Phase 9 - Billing
Add Stripe subscriptions with three plans (Starter, Growth, Pro) that set the
monthly lead limit and AI cost cap. Include the customer portal and handle
webhooks for paid, failed, and cancelled. Block AI processing for unpaid orgs.

## Phase 10 - Dashboard and weekly report
Build a dashboard: leads this week, average reply time, calls booked, AI cost.
Add a Monday job that emails the owner a one-page weekly report.

## Phase 11 - Deploy
Write Dockerfiles for the web app and worker and a guide to deploy both on a VPS
with Coolify, including environment variables, HTTPS, database backups, and
error logging. Run the full test suite and type checker before we deploy.

---

## Tips
- If Claude Code goes off track: "Stop. Re-read CLAUDE.md and tell me what you changed."
- After each phase: "Review this phase for security problems and missing tests."
- Before real customers: use Stripe test mode and a test Telegram bot until everything works.
- Gmail inbox reading is left out on purpose. Google requires a security review
  for apps that read users' email, which takes time and money. Add it after you
  have paying customers.
