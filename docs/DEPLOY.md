# Deploying DeskPilot on a VPS with Coolify

DeskPilot runs as two containers that share one Postgres database (Supabase):

| Container | Built from | What it does |
| --- | --- | --- |
| **web** | `Dockerfile` | Next.js app: pages, lead intake API, webhooks (Stripe, Cal.com, Telegram). Port 3000. |
| **worker** | `Dockerfile.worker` | pg-boss jobs: AI drafts, notifications, sending, follow-ups, weekly reports. Applies DB migrations on start. No port. |

Both are stateless. All state lives in Supabase Postgres (data, auth, job queue).

> Why not Vercel? Vercel's free Hobby plan does not allow commercial use, and the
> worker needs a long-running process. A €5–10/month VPS runs both.

---

## 0. Before every deploy

```bash
npm ci
npm run check        # typecheck + lint + tests + web build + worker build
```

`npm run check` must pass. CI (`.github/workflows/ci.yml`) runs the same on every push and pull request.

---

## 1. Accounts and keys

Collect these first (all have free tiers to start). Use **test mode / test bots** until everything works end to end.

| Service | What to create | Env vars |
| --- | --- | --- |
| Supabase | A project (pick the region closest to your customers) | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `DATABASE_URL` |
| Anthropic | An API key; set a monthly spend limit in the Console as a backstop | `ANTHROPIC_API_KEY` |
| Resend | An API key with *Full access* (it creates sending domains for your customers) and one verified domain of your own for platform email | `RESEND_API_KEY`, `SYSTEM_FROM_EMAIL` |
| Telegram | A bot via @BotFather | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET` |
| Stripe | Three recurring monthly prices + a webhook endpoint (step 6) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_PRO` |
| Cal.com | Nothing global — each business adds its own webhook from *Settings → Website & Cal.com* | — |

### Supabase details

- **DATABASE_URL**: *Project Settings → Database → Connection string → URI*, the **direct connection or the session pooler (port 5432)**. Do **not** use the transaction pooler (port 6543): pg-boss needs session features. Append `?sslmode=require`.
- **Auth → URL configuration**: set *Site URL* to your `APP_URL` and add `https://YOUR-DOMAIN/auth/callback` to *Redirect URLs*.
- **Auth → Email**: keep *Confirm email* on. For production, set up custom SMTP (Resend works) so confirmation emails don't hit Supabase's low default rate limit.
- **Database → Backups**: see step 8.

---

## 2. Server

1. Create a VPS — e.g. Hetzner CX22 (2 vCPU, 4 GB RAM) or a DigitalOcean 4 GB droplet, Ubuntu 24.04.
2. Point DNS at it: an `A` record for `app.yourdomain.com` (and optionally a wildcard for Coolify's own dashboard).
3. Install Coolify (as root):

   ```bash
   curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
   ```

4. Open `http://SERVER_IP:8000`, create the admin account, and set a domain + HTTPS for the Coolify dashboard itself (*Settings → Instance's domain*).
5. Lock the server down: SSH keys only, a firewall that allows only 22, 80, 443 (and 8000 until the dashboard has its own domain).

---

## 3. Create the app in Coolify

Either option works. **Option A** gives you separate deploy logs, scaling and health checks per container.

### Option A — two Dockerfile resources (recommended)

1. *Projects → New → Add resource → Public/Private Repository* → select this repository and branch `main`.
2. **web**: Build pack *Dockerfile*, Dockerfile location `/Dockerfile`, port `3000`, domain `https://app.yourdomain.com`, health check path `/api/health`.
3. Add a second resource from the same repository for **worker**: Build pack *Dockerfile*, Dockerfile location `/Dockerfile.worker`, **no domain**, and turn off the HTTP health check (the worker has no port; Docker restarts it if it exits).
4. Enable *Auto deploy* on push (or deploy from CI after `npm run check` passes).

### Option B — one Docker Compose resource

Add a resource with build pack *Docker Compose* and `docker-compose.yml`. Assign the domain to the `web` service on port 3000.

---

## 4. Environment variables

Set these on **both** web and worker (Coolify: *Environment Variables*, mark secrets as such). See `.env.example` for descriptions.

```
APP_URL=https://app.yourdomain.com
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
DATABASE_URL=postgresql://...:5432/postgres?sslmode=require
DATABASE_POOL_MAX=10
ANTHROPIC_API_KEY=...
RESEND_API_KEY=...
SYSTEM_FROM_EMAIL=DeskPilot <reports@mail.yourdomain.com>
TELEGRAM_BOT_TOKEN=...
TELEGRAM_BOT_USERNAME=YourDeskPilotBot
TELEGRAM_WEBHOOK_SECRET=<random, letters/digits/_/- only>
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_STARTER=price_...
STRIPE_PRICE_GROWTH=price_...
STRIPE_PRICE_PRO=price_...
STRIPE_TRIAL_DAYS=14
TRUSTED_PROXY_HOPS=1
WORKER_CONCURRENCY=4
WEEKLY_REPORT_HOUR=8
LOG_LEVEL=info
```

Worker only: `RUN_MIGRATIONS=true` (default) applies pending migrations on start. Set it to `false` if you prefer to run `npm run db:migrate` yourself.

Notes:

- Secrets are only read on the server. Nothing except the Supabase URL/anon key has the `NEXT_PUBLIC_` prefix, and even those are read at runtime, so one image works for any environment.
- Generate secrets with `openssl rand -hex 32`.
- `TRUSTED_PROXY_HOPS` tells the rate limiter which `X-Forwarded-For` entry is real: 1 behind Coolify's Traefik, 2 if you put a CDN (e.g. Cloudflare) in front. Never expose the containers' port 3000 directly to the internet — traffic must come through the proxy, or clients could fake their IP.
- Connection budget: each web and worker container opens up to `DATABASE_POOL_MAX` (+ a few for pg-boss). Stay under your Supabase plan's connection limit when you scale.

---

## 5. HTTPS

Coolify's proxy (Traefik) issues and renews Let's Encrypt certificates automatically for every domain you assign. Make sure:

- the domain in Coolify starts with `https://`,
- DNS points at the server **before** the first deploy (the certificate challenge needs it),
- ports 80 and 443 are open.

Telegram and Stripe webhooks require HTTPS, so do this before step 6.

---

## 6. First deploy and webhooks

1. Deploy **worker** first: its logs should show `applying 20261113000100_core_schema.sql ...`, `Migrations applied.`, then `worker started`.
2. Deploy **web**. `https://app.yourdomain.com/api/health` should return `{"ok":true}`.
3. **Telegram**: register the webhook once (from your machine, with the production env values):

   ```bash
   APP_URL=https://app.yourdomain.com TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... npm run telegram:set-webhook
   ```

4. **Stripe** (*Developers → Webhooks → Add endpoint*): URL `https://app.yourdomain.com/api/webhooks/stripe`, events:
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`,
   `invoice.paid`, `invoice.payment_failed`. Copy the signing secret into `STRIPE_WEBHOOK_SECRET` and redeploy web.
   Also configure the **customer portal** (*Settings → Billing → Customer portal*): allow switching between the three prices, updating payment methods and cancelling.
5. **Cal.com**: nothing to do globally. Each business copies its own URL and secret from *Settings → Website & Cal.com*.
6. **Resend**: verify your own domain for `SYSTEM_FROM_EMAIL`. Customer domains are added by each business in *Settings → Email sending*.

### Smoke test (test mode)

1. Sign up, create a business, finish onboarding.
2. Subscribe with Stripe test card `4242 4242 4242 4242` → billing page shows *Free trial*.
3. Add a sending domain you control and verify it.
4. Connect Telegram; press *Send test message*.
5. Submit the website form (Settings → Website & Cal.com → embed snippet on any page, or the `curl` example).
6. Within ~10 seconds a draft appears in the inbox and in Telegram. Approve it → the email arrives from your domain.
7. Book through your Cal.com link with the same email → the lead shows *Booked* and follow-ups stop.

---

## 7. Error logging and monitoring

- **Logs**: both containers write one JSON object per line (`time`, `level`, `msg`, plus fields like `orgId`, `job`, `err`). View them in Coolify (*Logs* tab per resource). Use `LOG_LEVEL=debug` temporarily when investigating.
- **What to watch for**: `"level":"error"` lines such as `job failed`, `lead intake failed`, `stripe event failed`, `telegram update failed`, `worker crashed on startup`.
- **Alerts**: in Coolify *Notifications*, enable email/Telegram/Discord alerts for deployment failures and container restarts/unhealthy status.
- **Uptime**: point an uptime monitor (Better Stack, UptimeRobot) at `https://app.yourdomain.com/api/health` (checks the web app *and* the database).
- **Central logs (optional)**: Coolify can forward container logs to a log drain (e.g. Axiom, New Relic, Highlight). Because logs are already JSON, they are searchable there without extra parsing. Create an alert on `level = "error"`.
- **Job queue**: failed jobs are retried with backoff (3–5 times) and then kept in the `pgboss.job` table with `state = 'failed'`. Quick check:

  ```sql
  select name, state, count(*) from pgboss.job group by 1, 2 order by 1, 2;
  ```

- **AI spend**: per-org usage is in `public.llm_usage`; each plan has a hard monthly cap enforced in `src/lib/ai.ts`. Also set an organisation spend limit in the Anthropic Console.

---

## 8. Database backups

1. **Supabase backups (primary)**: on the Pro plan Supabase takes daily backups (7-day retention) and offers Point-in-Time Recovery as an add-on. Turn PITR on once you have paying customers. The free plan has **no** backups — upgrade before going live.
2. **Off-site copy (recommended)**: `scripts/backup.sh` dumps the `public`, `internal`, `pgboss` and `auth` schemas with `pg_dump` and uploads to any S3-compatible bucket (Hetzner Object Storage, Backblaze B2, Cloudflare R2, AWS S3). Run it nightly, e.g. as a cron job on the VPS host:

   ```cron
   # /opt/deskpilot/backup.env holds DATABASE_URL, BACKUP_S3_URI, BACKUP_S3_ENDPOINT,
   # AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (chmod 600).
   30 2 * * * docker run --rm --env-file /opt/deskpilot/backup.env \
     -v /opt/deskpilot/backup.sh:/backup.sh:ro postgres:17 \
     sh -c "apt-get update -qq && apt-get install -y -qq awscli >/dev/null && sh /backup.sh"
   ```

   Use a `pg_dump` version at least as new as your Supabase Postgres version, and set a lifecycle rule on the bucket (e.g. keep 30 days).
3. **Test a restore** every few months into a scratch database:

   ```bash
   pg_restore --no-owner --no-privileges --data-only --schema=public --dbname "$SCRATCH_DATABASE_URL" deskpilot-YYYYMMDDTHHMMSSZ.dump
   ```

   (Create the schema first with the migrations; restore `auth.users` before `public` so memberships keep their users.)

---

## 9. Updating

- Push to `main` → CI runs `npm run check` → Coolify redeploys (auto-deploy or webhook).
- The worker applies new migrations on start. Write migrations so the **old** web version still works with the new schema (add columns before using them, drop later), because web and worker restart one after the other.
- Graceful shutdown: the worker finishes in-flight jobs for up to 30 s on SIGTERM; unfinished jobs are retried by the next worker.

## 10. Scaling

- **More AI throughput**: raise `WORKER_CONCURRENCY` or run a second worker container. pg-boss uses `SKIP LOCKED`, so a job is never processed twice at the same time.
- **More web traffic**: run more web replicas behind Coolify's proxy. Rate limits are stored in Postgres, so they hold across replicas.
