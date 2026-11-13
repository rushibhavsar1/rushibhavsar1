import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { Db } from "@/lib/db";

/**
 * The bits of a Supabase database our migrations rely on: the auth schema,
 * auth.uid(), and the anon/authenticated/service_role roles.
 */
const SUPABASE_SHIM = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  created_at timestamptz not null default now()
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
-- Mimic Supabase's permissive default privileges so the migration has to
-- tighten them itself.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

function adapter(conn: PGlite | Transaction): Db {
  const self: Db = {
    query: async <T,>(text: string, params?: unknown[]) => {
      const res = await conn.query<T>(text, params as unknown[] | undefined);
      return { rows: res.rows };
    },
    transaction: async <T,>(fn: (tx: Db) => Promise<T>) => {
      if ("transaction" in conn && typeof conn.transaction === "function") {
        return (conn as PGlite).transaction((tx) => fn(adapter(tx)));
      }
      return fn(self);
    },
  };
  return self;
}

export function migrationFiles(): string[] {
  const dir = join(process.cwd(), "supabase", "migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => join(dir, f));
}

export interface TestDatabase {
  db: Db;
  pg: PGlite;
  close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDatabase> {
  const pg = new PGlite();
  await pg.exec(SUPABASE_SHIM);
  for (const file of migrationFiles()) {
    await pg.exec(readFileSync(file, "utf8"));
  }
  return { db: adapter(pg), pg, close: () => pg.close() };
}

export async function createUser(db: Db, email: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>("insert into auth.users (email) values ($1) returning id", [email]);
  return rows[0]!.id;
}
