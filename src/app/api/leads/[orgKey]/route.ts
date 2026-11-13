import { getDb } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getQueue } from "@/lib/queue";
import { CORS_HEADERS, handleLeadOptions, handleLeadPost } from "@/server/http/lead-endpoint";
import { json } from "@/server/http/request";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ orgKey: string }> }) {
  const { orgKey } = await params;
  try {
    return await handleLeadPost(request, orgKey, { db: getDb(), queue: getQueue() });
  } catch (err) {
    logger.error("lead intake failed", { err });
    return json({ error: "Something went wrong" }, { status: 500, headers: CORS_HEADERS });
  }
}

export function OPTIONS() {
  return handleLeadOptions();
}
