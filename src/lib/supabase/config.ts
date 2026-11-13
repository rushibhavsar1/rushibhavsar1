/**
 * Public Supabase settings (the anon key is safe in a browser — RLS protects
 * the data — but DeskPilot only uses it on the server).
 *
 * Read with a dynamic key on purpose: Next.js inlines literal
 * `process.env.NEXT_PUBLIC_*` references at build time, which would bake one
 * environment's values into the Docker image. This keeps them runtime config.
 */
function runtimeEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

export function supabasePublicConfig(): { url: string; anonKey: string } {
  const url = runtimeEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = runtimeEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (!url || !anonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. See .env.example.");
  }
  return { url, anonKey };
}
