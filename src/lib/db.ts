import pg from "pg";
import { env, requireEnv } from "@/lib/env";

/**
 * Minimal database interface used by all server-side data access.
 *
 * Implemented by node-postgres in production and by PGlite (real Postgres
 * compiled to WASM) in tests, so the same SQL — including RLS policies — is
 * exercised in both.
 */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs `fn` inside a transaction. Nested calls reuse the outer transaction. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

function clientDb(client: pg.PoolClient): Db {
  const self: Db = {
    query: async <T,>(text: string, params?: unknown[]) => {
      const res = await client.query(text, params as unknown[] | undefined);
      return { rows: res.rows as T[] };
    },
    transaction: (fn) => fn(self),
  };
  return self;
}

export function createPgDb(pool: pg.Pool): Db {
  return {
    query: async <T,>(text: string, params?: unknown[]) => {
      const res = await pool.query(text, params as unknown[] | undefined);
      return { rows: res.rows as T[] };
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn(clientDb(client));
        await client.query("commit");
        return result;
      } catch (err) {
        await client.query("rollback").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

// Keep one pool per process (survives Next.js dev hot reloads).
const globalForDb = globalThis as unknown as { __deskpilotPool?: pg.Pool; __deskpilotDb?: Db };

export function getPool(): pg.Pool {
  if (!globalForDb.__deskpilotPool) {
    globalForDb.__deskpilotPool = new pg.Pool({
      connectionString: requireEnv("DATABASE_URL"),
      max: env().DATABASE_POOL_MAX,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return globalForDb.__deskpilotPool;
}

/**
 * Service connection (database owner). Bypasses RLS — every query made with it
 * must be scoped by org_id. Never use it to read data for a user without first
 * checking membership (see src/server/auth/context.ts).
 */
export function getDb(): Db {
  if (!globalForDb.__deskpilotDb) {
    globalForDb.__deskpilotDb = createPgDb(getPool());
  }
  return globalForDb.__deskpilotDb;
}

/**
 * Runs `fn` with the privileges of a signed-in Supabase user, so Row Level
 * Security applies exactly as it does for the Supabase Data API: the
 * transaction switches to the `authenticated` role and sets the JWT claims
 * that `auth.uid()` reads.
 */
export async function asUser<T>(db: Db, userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
    await tx.query("set local role authenticated");
    return fn(tx);
  });
}
