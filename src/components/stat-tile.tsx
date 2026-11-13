/**
 * KPI stat tile: label, value, and an optional delta vs a named period.
 * Direction is shown with an arrow and words, never colour alone.
 */
export function StatTile({
  label,
  value,
  delta,
  hint,
}: {
  label: string;
  value: string;
  delta?: { text: string; direction: "up" | "down" | "flat"; good: boolean | null } | null;
  hint?: string;
}) {
  const tone =
    !delta || delta.direction === "flat" || delta.good === null
      ? "text-slate-500"
      : delta.good
        ? "text-emerald-700"
        : "text-red-700";
  const arrow = delta?.direction === "up" ? "▲" : delta?.direction === "down" ? "▼" : "–";
  return (
    <div className="card p-5">
      <p className="text-sm text-slate-600">{label}</p>
      <p className="mt-1 text-3xl font-semibold tracking-tight text-slate-900 tabular-nums">{value}</p>
      {delta ? (
        <p className={`mt-1 text-xs ${tone}`}>
          <span aria-hidden>{arrow}</span> {delta.text}
        </p>
      ) : null}
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

/** Builds a delta for StatTile. `upIsGood` false for things like reply time and cost. */
export function compare(
  current: number | null,
  previous: number | null,
  opts: {
    upIsGood: boolean | null;
    format: (n: number) => string;
    period: string;
    /** Words for an increase / a decrease, e.g. ["slower", "faster"]. */
    words?: [string, string];
  },
) {
  if (current === null || previous === null) return null;
  const diff = current - previous;
  if (Math.abs(diff) < 1e-9) return { text: `same as ${opts.period}`, direction: "flat" as const, good: null };
  const direction = diff > 0 ? ("up" as const) : ("down" as const);
  const good = opts.upIsGood === null ? null : diff > 0 === opts.upIsGood;
  const [more, less] = opts.words ?? ["more", "less"];
  return { text: `${opts.format(Math.abs(diff))} ${diff > 0 ? more : less} than ${opts.period}`, direction, good };
}
