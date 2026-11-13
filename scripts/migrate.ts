/**
 * Applies supabase/migrations/*.sql in order to DATABASE_URL.
 *
 * Applied versions are recorded in supabase_migrations.schema_migrations — the
 * same table the Supabase CLI uses — so `supabase db push` and this script can
 * be mixed. Each file runs in its own transaction.
 *
 *   npm run db:migrate            apply pending migrations
 *   npm run db:migrate -- --dry   list pending migrations only
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. See .env.example.");
  const dryRun = process.argv.includes("--dry");

  const dir = join(process.cwd(), "supabase", "migrations");
  const files = readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("create schema if not exists supabase_migrations");
    await client.query(
      `create table if not exists supabase_migrations.schema_migrations (
         version text primary key,
         statements text[],
         name text
       )`,
    );
    const { rows } = await client.query<{ version: string }>("select version from supabase_migrations.schema_migrations");
    const applied = new Set(rows.map((r) => r.version));

    const pending = files.filter((f) => !applied.has(f.split("_")[0]!));
    if (pending.length === 0) {
      console.log("Database is up to date.");
      return;
    }
    for (const file of pending) {
      const [version, ...rest] = file.replace(/\.sql$/, "").split("_");
      if (dryRun) {
        console.log(`pending: ${file}`);
        continue;
      }
      const sql = readFileSync(join(dir, file), "utf8");
      console.log(`applying ${file} ...`);
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(
          "insert into supabase_migrations.schema_migrations (version, statements, name) values ($1, $2, $3)",
          [version, [sql], rest.join("_")],
        );
        await client.query("commit");
      } catch (err) {
        await client.query("rollback");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    console.log(dryRun ? "Dry run complete." : "Migrations applied.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
