import { z } from "zod";

/**
 * The knowledge files every business fills in during onboarding. They are
 * fed to the AI (with prompt caching) whenever it writes a reply.
 */
export const KNOWLEDGE_SLUGS = ["voice", "services", "faqs", "booking", "banned_words"] as const;
export type KnowledgeSlug = (typeof KNOWLEDGE_SLUGS)[number];

export interface KnowledgeFileDef {
  slug: KnowledgeSlug;
  title: string;
  question: string;
  help: string;
  placeholder: string;
  input: "textarea" | "url";
  required: boolean;
}

export const KNOWLEDGE_FILES: readonly KnowledgeFileDef[] = [
  {
    slug: "voice",
    title: "Tone of voice",
    question: "How do you talk to your customers?",
    help: "Describe your style (friendly? formal? short?) and how you sign off. Pasting one or two real messages you've sent works best.",
    placeholder:
      "Warm and down-to-earth, never pushy. Short paragraphs. We use first names.\nSign off as: Maria, Bright Smile Dental\n\nExample reply:\nHi Tom! Thanks for reaching out…",
    input: "textarea",
    required: true,
  },
  {
    slug: "services",
    title: "Services and prices",
    question: "What do you offer, and what does it cost?",
    help: "List your services with prices or price ranges. Mention what's included and anything you don't do.",
    placeholder: "Teeth whitening — $299 (one session, 60 min)\nCheck-up + clean — $120\nWe don't do braces.",
    input: "textarea",
    required: true,
  },
  {
    slug: "faqs",
    title: "Common questions",
    question: "What do people usually ask before they buy?",
    help: "Write the question and your usual answer. Opening hours, location, parking, payment options, guarantees…",
    placeholder: "Q: Do you take insurance?\nA: Yes, most major plans — bring your card.\n\nQ: Where do I park?\nA: Free parking behind the building.",
    input: "textarea",
    required: false,
  },
  {
    slug: "booking",
    title: "Booking link",
    question: "Where can people book a call or appointment?",
    help: "Your Cal.com (or other) booking page. Every reply will invite the lead to book here.",
    placeholder: "https://cal.com/your-business/intro-call",
    input: "url",
    required: true,
  },
  {
    slug: "banned_words",
    title: "Words to never use",
    question: "Any words or phrases we should never write?",
    help: "One per line. For example competitor names, “cheap”, or promises you can't make.",
    placeholder: "cheap\nguarantee\nASAP",
    input: "textarea",
    required: false,
  },
];

export function isKnowledgeSlug(value: string): value is KnowledgeSlug {
  return (KNOWLEDGE_SLUGS as readonly string[]).includes(value);
}

export function knowledgeDef(slug: KnowledgeSlug): KnowledgeFileDef {
  return KNOWLEDGE_FILES.find((f) => f.slug === slug)!;
}

const text = (max: number) =>
  z
    .string()
    .transform((v) => v.replace(/\r\n/g, "\n").trim())
    .pipe(z.string().max(max, `Keep it under ${max} characters`));

const validators: Record<KnowledgeSlug, z.ZodType<string, string>> = {
  voice: text(8000),
  services: text(8000),
  faqs: text(12000),
  booking: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === "" || /^https:\/\/[^\s]+$/i.test(v), "Enter a full https:// link")
    .refine((v) => {
      if (v === "") return true;
      try {
        new URL(v);
        return true;
      } catch {
        return false;
      }
    }, "That doesn't look like a valid link"),
  banned_words: z
    .string()
    .max(4000)
    .transform((v) =>
      Array.from(
        new Set(
          v
            .split(/[\n,]/)
            .map((w) => w.trim())
            .filter((w) => w.length > 0 && w.length <= 60),
        ),
      ).join("\n"),
    ),
};

/** Validates and normalizes the content of one knowledge file. */
export function parseKnowledgeContent(slug: KnowledgeSlug, raw: string, opts: { requireFilled?: boolean } = {}) {
  const result = validators[slug].safeParse(raw ?? "");
  if (!result.success) return { ok: false as const, error: result.error.issues[0]?.message ?? "Invalid value" };
  if (opts.requireFilled && knowledgeDef(slug).required && result.data.length === 0) {
    return { ok: false as const, error: "This one is needed for good replies." };
  }
  return { ok: true as const, content: result.data };
}

/** Banned words as a list (from the normalized banned_words file). */
export function bannedWordsList(content: string | undefined): string[] {
  return (content ?? "")
    .split("\n")
    .map((w) => w.trim())
    .filter(Boolean);
}
