/**
 * Tiny structured logger: one JSON object per line on stdout/stderr.
 * Coolify (and most log collectors) parse this format directly.
 */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const raw = (process.env.LOG_LEVEL ?? "info") as Level;
  return ORDER[raw] ?? ORDER.info;
}

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { message: String(err) };
}

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < threshold()) return;
  if (process.env.NODE_ENV === "test" && level !== "error") return;
  const record: Record<string, unknown> = { time: new Date().toISOString(), level, msg };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      record[k] = k === "err" || v instanceof Error ? serializeError(v) : v;
    }
  }
  const line = JSON.stringify(record);
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};
