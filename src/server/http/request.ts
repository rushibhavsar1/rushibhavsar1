/**
 * Client IP for rate limiting.
 *
 * X-Forwarded-For is a list the client can pre-fill, so only entries added by
 * our own proxies can be trusted: we take the one `trustedHops` from the right.
 * Behind Coolify (Traefik) that is 1; put a CDN in front and it becomes 2
 * (set TRUSTED_PROXY_HOPS).
 */
export function clientIp(req: Request, trustedHops = Number(process.env.TRUSTED_PROXY_HOPS ?? 1)): string {
  const hops = Number.isInteger(trustedHops) && trustedHops >= 1 ? trustedHops : 1;
  const forwarded = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (forwarded.length > 0) {
    return forwarded[Math.max(0, forwarded.length - hops)]!.slice(0, 64);
  }
  return (req.headers.get("x-real-ip") ?? "unknown").trim().slice(0, 64);
}

export class BodyTooLargeError extends Error {}

/** Reads the raw body with a hard size limit (protects against huge payloads). */
export async function readBodyText(req: Request, maxBytes: number): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new BodyTooLargeError();
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}
