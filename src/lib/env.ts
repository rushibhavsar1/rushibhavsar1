import { z } from "zod";

/**
 * Server-side environment, validated with Zod.
 *
 * Values are read lazily so that unit tests and `next build` work without
 * every integration configured. Use `requireEnv()` at the point where an
 * integration is actually used to get a clear error if it is missing.
 */
const optional = z
  .string()
  .trim()
  .transform((v) => (v === "" ? undefined : v))
  .optional();

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.url().default("http://localhost:3000"),

  NEXT_PUBLIC_SUPABASE_URL: optional,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: optional,
  DATABASE_URL: optional,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  ANTHROPIC_API_KEY: optional,

  RESEND_API_KEY: optional,
  SYSTEM_FROM_EMAIL: optional,

  TELEGRAM_BOT_TOKEN: optional,
  TELEGRAM_BOT_USERNAME: optional,
  TELEGRAM_WEBHOOK_SECRET: optional,

  STRIPE_SECRET_KEY: optional,
  STRIPE_WEBHOOK_SECRET: optional,
  STRIPE_PRICE_STARTER: optional,
  STRIPE_PRICE_GROWTH: optional,
  STRIPE_PRICE_PRO: optional,
  STRIPE_TRIAL_DAYS: z.coerce.number().int().min(0).max(90).default(14),

  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(4),
  /** Local hour (in each business's time zone) on Monday when the weekly report goes out. */
  WEEKLY_REPORT_HOUR: z.coerce.number().int().min(0).max(23).default(8),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | undefined;

export function env(): ServerEnv {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Invalid environment: ${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

type RequiredKey = {
  [K in keyof ServerEnv]-?: undefined extends ServerEnv[K] ? K : never;
}[keyof ServerEnv];

/** Returns a configured value or throws a clear error naming the missing variable. */
export function requireEnv<K extends RequiredKey>(key: K): NonNullable<ServerEnv[K]> {
  const value = env()[key];
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing environment variable ${key}. See .env.example.`);
  }
  return value as NonNullable<ServerEnv[K]>;
}

/** For tests: forget the cached environment. */
export function resetEnvCache(): void {
  cached = undefined;
}
