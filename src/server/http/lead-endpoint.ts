import type { Db } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { Queue } from "@/lib/queue";
import { intakeLead, leadInput } from "@/server/leads/intake";
import { getOrganizationByKey } from "@/server/orgs";
import { hitRateLimit } from "@/server/rate-limit";
import { BodyTooLargeError, clientIp, json, readBodyText } from "@/server/http/request";

const MAX_BODY_BYTES = 16 * 1024;
const ORG_KEY = /^[a-f0-9]{32}$/;

/** The intake endpoint is public and called from customer websites. */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

export const LIMITS = {
  perIp: { limit: 5, windowSeconds: 600 },
  perOrg: { limit: 120, windowSeconds: 3600 },
};

function reply(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return json(body, { status, headers: { ...CORS_HEADERS, ...extra } });
}

async function parseBody(req: Request): Promise<unknown> {
  const text = await readBodyText(req, MAX_BODY_BYTES);
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  return JSON.parse(text || "{}");
}

/** POST /api/leads/:orgKey */
export async function handleLeadPost(
  req: Request,
  orgKey: string,
  deps: { db: Db; queue: Queue },
): Promise<Response> {
  if (!ORG_KEY.test(orgKey)) return reply(404, { error: "Unknown form" });

  const ip = clientIp(req);
  const ipLimit = await hitRateLimit(
    deps.db,
    `lead:ip:${orgKey}:${ip}`,
    LIMITS.perIp.limit,
    LIMITS.perIp.windowSeconds,
  );
  if (!ipLimit.allowed) {
    return reply(429, { error: "Too many requests. Please try again later." }, {
      "Retry-After": String(ipLimit.retryAfterSeconds),
    });
  }

  let raw: unknown;
  try {
    raw = await parseBody(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return reply(413, { error: "Message is too large" });
    return reply(400, { error: "Invalid request body" });
  }

  const parsed = leadInput.safeParse(raw);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "form");
      fields[key] ??= issue.message;
    }
    return reply(422, { error: "Please check the form", fields });
  }

  const org = await getOrganizationByKey(deps.db, orgKey);
  if (!org) return reply(404, { error: "Unknown form" });

  const orgLimit = await hitRateLimit(
    deps.db,
    `lead:org:${org.id}`,
    LIMITS.perOrg.limit,
    LIMITS.perOrg.windowSeconds,
  );
  if (!orgLimit.allowed) {
    logger.warn("lead intake org rate limit hit", { orgId: org.id });
    return reply(429, { error: "Too many requests. Please try again later." }, {
      "Retry-After": String(orgLimit.retryAfterSeconds),
    });
  }

  const result = await intakeLead(deps, org, parsed.data, {
    ip,
    userAgent: req.headers.get("user-agent"),
  });
  // Honeypot hits get the same success response so bots learn nothing.
  return reply(result.status === "accepted" ? 201 : 200, { ok: true });
}

export function handleLeadOptions(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
