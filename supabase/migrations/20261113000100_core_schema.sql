-- DeskPilot core schema.
--
-- Security model
--   * Every tenant table carries org_id and has Row Level Security enabled.
--   * Signed-in users (role `authenticated`) can only SELECT rows of the
--     organizations they are a member of. They cannot write directly through the
--     Supabase Data API: all writes go through the app server, which checks
--     membership and business rules first (approval before sending, billing...).
--   * The `anon` role gets nothing.
--   * The server and worker connect as the database owner and bypass RLS; that
--     code always scopes queries by org_id explicitly.

-- ─────────────────────────────────────────────────────────────────────────────
-- Organizations (one business = one org)
-- ─────────────────────────────────────────────────────────────────────────────
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),

  -- Public key used in the lead intake URL and the embeddable widget.
  org_key text not null unique default replace(gen_random_uuid()::text, '-', ''),

  -- Billing (kept in sync by the Stripe webhook).
  plan text not null default 'none' check (plan in ('none', 'starter', 'growth', 'pro')),
  subscription_status text not null default 'none' check (
    subscription_status in (
      'none', 'trialing', 'active', 'past_due', 'unpaid', 'canceled',
      'incomplete', 'incomplete_expired', 'paused'
    )
  ),
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  current_period_end timestamptz,

  -- Telegram approvals.
  telegram_chat_id bigint,
  telegram_link_code text unique,
  telegram_link_expires_at timestamptz,

  -- MVP rule: never send without approval. The constraint makes it impossible
  -- to switch on by accident.
  auto_send_enabled boolean not null default false check (auto_send_enabled = false),

  -- Outgoing email (Resend).
  sending_domain text check (sending_domain is null or sending_domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  resend_domain_id text,
  sending_domain_status text not null default 'not_started'
    check (sending_domain_status in ('not_started', 'pending', 'verified', 'failed')),
  from_name text check (from_name is null or char_length(from_name) <= 80),
  from_local_part text not null default 'hello' check (from_local_part ~ '^[a-z0-9._+-]{1,64}$'),
  reply_to_email text check (reply_to_email is null or char_length(reply_to_email) <= 254),

  -- Cal.com: per-org signing secret for the bookings webhook.
  calcom_webhook_secret text not null
    default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),

  timezone text not null default 'UTC',
  onboarding_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Memberships
-- ─────────────────────────────────────────────────────────────────────────────
create table public.memberships (
  user_id uuid not null references auth.users (id) on delete cascade,
  org_id uuid not null references public.organizations (id) on delete cascade,
  role text not null default 'owner' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (user_id, org_id)
);
create index memberships_org_id_idx on public.memberships (org_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Knowledge files (voice, services & prices, FAQs, booking link, banned words)
-- ─────────────────────────────────────────────────────────────────────────────
create table public.knowledge_files (
  org_id uuid not null references public.organizations (id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9_-]{1,40}$'),
  content text not null default '' check (char_length(content) <= 20000),
  updated_at timestamptz not null default now(),
  primary key (org_id, slug)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Leads
-- ─────────────────────────────────────────────────────────────────────────────
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  name text check (name is null or char_length(name) <= 120),
  email text not null check (char_length(email) <= 254),
  phone text check (phone is null or char_length(phone) <= 40),
  source text not null default 'form' check (char_length(source) <= 40),
  -- Untrusted text from the public. Never treated as instructions.
  message text not null check (char_length(message) <= 5000),
  status text not null default 'new'
    check (status in ('new', 'drafted', 'awaiting_approval', 'replied', 'booked', 'lost')),
  classification text check (classification in ('spam', 'lead', 'support')),
  classification_reason text,
  first_replied_at timestamptz,
  lead_responded_at timestamptz,
  booked_at timestamptz,
  followups_stopped_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id)
);
create index leads_org_created_idx on public.leads (org_id, created_at desc);
create index leads_org_email_idx on public.leads (org_id, lower(email));
create index leads_org_status_idx on public.leads (org_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- Drafts (AI replies waiting for approval)
-- ─────────────────────────────────────────────────────────────────────────────
create table public.drafts (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null,
  org_id uuid not null references public.organizations (id) on delete cascade,
  kind text not null check (kind in ('first_reply', 'followup_1', 'followup_2')),
  subject text not null default '' check (char_length(subject) <= 200),
  body text not null check (char_length(body) <= 20000),
  status text not null default 'pending_approval'
    check (status in ('pending_approval', 'approved', 'rejected', 'sent', 'cancelled')),
  model text,
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  approved_via text check (approved_via in ('web', 'telegram')),
  sent_at timestamptz,
  resend_email_id text,
  send_error text,
  telegram_message_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A draft always belongs to a lead of the same organization.
  foreign key (lead_id, org_id) references public.leads (id, org_id) on delete cascade
);
create index drafts_org_status_idx on public.drafts (org_id, status, created_at desc);
create index drafts_lead_idx on public.drafts (lead_id);
-- At most one live draft per lead and kind. Makes AI jobs safe to retry.
create unique index drafts_one_live_per_kind
  on public.drafts (lead_id, kind)
  where status in ('pending_approval', 'approved', 'sent');

-- ─────────────────────────────────────────────────────────────────────────────
-- Events (audit log)
-- ─────────────────────────────────────────────────────────────────────────────
create table public.events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  lead_id uuid,
  type text not null check (char_length(type) <= 60),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (lead_id, org_id) references public.leads (id, org_id) on delete cascade
);
create index events_org_created_idx on public.events (org_id, created_at desc);
create index events_lead_idx on public.events (lead_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- LLM usage (tokens + cost per org, written by src/lib/ai.ts only)
-- ─────────────────────────────────────────────────────────────────────────────
create table public.llm_usage (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  model text not null,
  purpose text not null default 'unknown',
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cached_tokens integer not null default 0 check (cached_tokens >= 0),
  cache_write_tokens integer not null default 0 check (cache_write_tokens >= 0),
  cost_usd numeric(12, 6) not null default 0 check (cost_usd >= 0),
  lead_id uuid,
  created_at timestamptz not null default now()
);
create index llm_usage_org_created_idx on public.llm_usage (org_id, created_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- updated_at maintenance
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.touch_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger organizations_touch before update on public.organizations
  for each row execute function public.touch_updated_at();
create trigger knowledge_files_touch before update on public.knowledge_files
  for each row execute function public.touch_updated_at();
create trigger leads_touch before update on public.leads
  for each row execute function public.touch_updated_at();
create trigger drafts_touch before update on public.drafts
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────────────────────────────────────────

-- SECURITY DEFINER so policies on other tables can check membership without
-- recursing into the memberships policies.
create or replace function public.is_org_member(target_org uuid) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = target_org and m.user_id = (select auth.uid())
  );
$$;
revoke all on function public.is_org_member(uuid) from public;
grant execute on function public.is_org_member(uuid) to authenticated;

alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.knowledge_files enable row level security;
alter table public.leads enable row level security;
alter table public.drafts enable row level security;
alter table public.events enable row level security;
alter table public.llm_usage enable row level security;

create policy "members read their organization" on public.organizations
  for select to authenticated using (public.is_org_member(id));

create policy "members read memberships of their organization" on public.memberships
  for select to authenticated using (user_id = (select auth.uid()) or public.is_org_member(org_id));

create policy "members read knowledge files" on public.knowledge_files
  for select to authenticated using (public.is_org_member(org_id));

create policy "members read leads" on public.leads
  for select to authenticated using (public.is_org_member(org_id));

create policy "members read drafts" on public.drafts
  for select to authenticated using (public.is_org_member(org_id));

create policy "members read events" on public.events
  for select to authenticated using (public.is_org_member(org_id));

create policy "members read llm usage" on public.llm_usage
  for select to authenticated using (public.is_org_member(org_id));

-- Table privileges: read-only for signed-in users, nothing for anonymous users.
-- (Supabase grants everything to anon/authenticated by default; tighten it.)
revoke all on table
  public.organizations, public.memberships, public.knowledge_files, public.leads,
  public.drafts, public.events, public.llm_usage
from anon, authenticated;

grant select on table
  public.organizations, public.memberships, public.knowledge_files, public.leads,
  public.drafts, public.events, public.llm_usage
to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Internal tables (not exposed through the Supabase Data API)
-- ─────────────────────────────────────────────────────────────────────────────
create schema if not exists internal;
revoke all on schema internal from public;
revoke all on schema internal from anon, authenticated;

-- Fixed-window rate limiting shared by every web instance.
create table internal.rate_limits (
  key text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (key, window_start)
);
alter table internal.rate_limits enable row level security;

-- Webhook idempotency (Stripe/Cal.com retries deliver the same event again).
create table internal.webhook_events (
  source text not null,
  event_id text not null,
  received_at timestamptz not null default now(),
  primary key (source, event_id)
);
alter table internal.webhook_events enable row level security;
