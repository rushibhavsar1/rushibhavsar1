/** Row shapes for the tables in supabase/migrations. Timestamps arrive as Date objects. */

export type PlanId = "none" | "starter" | "growth" | "pro";
export type SubscriptionStatus =
  | "none"
  | "trialing"
  | "active"
  | "past_due"
  | "unpaid"
  | "canceled"
  | "incomplete"
  | "incomplete_expired"
  | "paused";
export type MemberRole = "owner" | "admin" | "member";
export type LeadStatus = "new" | "drafted" | "awaiting_approval" | "replied" | "booked" | "lost";
export type LeadClassification = "spam" | "lead" | "support";
export type DraftKind = "first_reply" | "followup_1" | "followup_2";
export type DraftStatus = "pending_approval" | "approved" | "rejected" | "sent" | "cancelled";
export type SendingDomainStatus = "not_started" | "pending" | "verified" | "failed";

export interface Organization {
  id: string;
  name: string;
  org_key: string;
  plan: PlanId;
  subscription_status: SubscriptionStatus;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: Date | null;
  /** Stored as bigint; selected as text to avoid precision loss. */
  telegram_chat_id: string | null;
  telegram_link_code: string | null;
  telegram_link_expires_at: Date | null;
  auto_send_enabled: boolean;
  sending_domain: string | null;
  resend_domain_id: string | null;
  sending_domain_status: SendingDomainStatus;
  from_name: string | null;
  from_local_part: string;
  reply_to_email: string | null;
  calcom_webhook_secret: string;
  timezone: string;
  onboarding_completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Columns to select for an Organization (casts bigint to text). */
export const ORG_COLUMNS = `
  o.id, o.name, o.org_key, o.plan, o.subscription_status, o.stripe_customer_id,
  o.stripe_subscription_id, o.current_period_end, o.telegram_chat_id::text as telegram_chat_id,
  o.telegram_link_code, o.telegram_link_expires_at, o.auto_send_enabled, o.sending_domain,
  o.resend_domain_id, o.sending_domain_status, o.from_name, o.from_local_part, o.reply_to_email,
  o.calcom_webhook_secret, o.timezone, o.onboarding_completed_at, o.created_at, o.updated_at`;

export interface Lead {
  id: string;
  org_id: string;
  name: string | null;
  email: string;
  phone: string | null;
  source: string;
  message: string;
  status: LeadStatus;
  classification: LeadClassification | null;
  classification_reason: string | null;
  first_replied_at: Date | null;
  lead_responded_at: Date | null;
  booked_at: Date | null;
  followups_stopped_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface Draft {
  id: string;
  lead_id: string;
  org_id: string;
  kind: DraftKind;
  subject: string;
  body: string;
  status: DraftStatus;
  model: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  approved_via: "web" | "telegram" | null;
  sent_at: Date | null;
  resend_email_id: string | null;
  send_error: string | null;
  telegram_message_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export const DRAFT_COLUMNS = `
  d.id, d.lead_id, d.org_id, d.kind, d.subject, d.body, d.status, d.model, d.approved_by,
  d.approved_at, d.approved_via, d.sent_at, d.resend_email_id, d.send_error,
  d.telegram_message_id::text as telegram_message_id, d.created_at, d.updated_at`;

export interface KnowledgeFile {
  org_id: string;
  slug: string;
  content: string;
  updated_at: Date;
}
