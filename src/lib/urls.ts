const BASE = "http://deskpilot.invalid";

/**
 * Only allow same-site relative redirects (prevents open redirects via ?next=).
 * Browsers strip tabs/newlines and treat backslashes as slashes, so the path is
 * limited to printable ASCII and must resolve to our own origin.
 */
export function safeNextPath(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next || typeof next !== "string" || next.length > 2000) return fallback;
  if (!/^\/[\x21-\x7e]*$/.test(next)) return fallback;
  if (next.startsWith("//") || next.startsWith("/\\")) return fallback;
  try {
    const url = new URL(next, BASE);
    if (url.origin !== BASE) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

/** Absolute URL on this app. */
export function appUrl(path: string): string {
  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
