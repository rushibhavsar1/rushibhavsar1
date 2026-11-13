import { getDb } from "@/lib/db";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/** Liveness + database check for Docker/Coolify health checks. */
export async function GET() {
  try {
    await getDb().query("select 1");
    return Response.json({ ok: true });
  } catch (err) {
    logger.error("health check failed", { err });
    return Response.json({ ok: false }, { status: 503 });
  }
}
