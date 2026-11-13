/**
 * Fills a local database with a demo business and realistic leads.
 *
 *   npm run db:seed -- --email you@example.com              demo data (no AI calls)
 *   npm run db:seed -- --email you@example.com --with-ai    + 8 tricky enquiries for the worker to draft
 *   npm run db:seed -- --email you@example.com --reset      remove earlier demo leads first
 *   options: --timezone Europe/London (for a newly created demo business)
 *
 * Sign up in the app with that email first. Demo leads use example.com
 * addresses, so approving a demo draft can never email a real person.
 */
import { getDb, getPool } from "@/lib/db";
import { getBoss, getQueue } from "@/lib/queue";
import { seedDemo } from "@/server/dev/seed";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  return value && !value.startsWith("--") ? value : "";
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set. See .env.example.");
  if (process.env.NODE_ENV === "production" && !flag("force")) {
    throw new Error("Refusing to seed demo data with NODE_ENV=production (pass --force if you really mean it).");
  }
  const email = arg("email");
  if (!email) throw new Error("Usage: npm run db:seed -- --email you@example.com [--with-ai] [--reset]");

  const db = getDb();
  const user = await db.query<{ id: string }>("select id from auth.users where lower(email) = lower($1)", [email]);
  const userId = user.rows[0]?.id;
  if (!userId) throw new Error(`No user with email ${email}. Sign up in the app first, then run this again.`);

  const withAi = flag("with-ai");
  const result = await seedDemo(db, {
    userId,
    reset: flag("reset"),
    withAi,
    queue: withAi ? getQueue() : null,
    timezone: arg("timezone") || undefined,
  });

  console.log(`Business: ${result.orgName}${result.createdOrg ? " (created)" : ""}`);
  if (result.removed) console.log(`Removed ${result.removed} earlier demo leads.`);
  if (result.markedTrial) console.log("Plan set to Starter (trial) so AI replies run locally — no Stripe needed.");
  if (result.knowledgeFilled.length) console.log(`Filled knowledge files: ${result.knowledgeFilled.join(", ")}`);
  if (result.alreadySeeded) console.log("Demo leads already exist (use --reset to recreate them).");
  else console.log(`Added ${result.leadsCreated} demo leads with ${result.draftsCreated} drafts.`);
  if (withAi) {
    console.log(`Queued ${result.enquiriesQueued} enquiries for the AI. Make sure \`npm run worker\` is running;`);
    console.log("drafts appear in the inbox within seconds. Read them critically: that's your quality check.");
  }
  console.log("Open http://localhost:3000/dashboard");

  if (withAi) await (await getBoss()).stop({ graceful: true, close: true });
  await getPool().end();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  try {
    if (process.env.DATABASE_URL) await getPool().end();
  } catch {
    // already closed
  }
  process.exit(1);
});
