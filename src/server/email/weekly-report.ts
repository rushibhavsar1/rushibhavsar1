import { formatDuration, formatUsd } from "@/components/format";
import { appUrl } from "@/lib/urls";
import type { PeriodStats } from "@/server/stats";

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function change(current: number | null, previous: number | null, format: (n: number) => string, lowerIsBetter = false) {
  if (current === null || previous === null) return "";
  const diff = current - previous;
  if (Math.abs(diff) < 1e-9) return "same as the week before";
  const up = diff > 0;
  const word = lowerIsBetter ? (up ? "slower" : "faster") : up ? "more" : "less";
  return `${up ? "▲" : "▼"} ${format(Math.abs(diff))} ${word} than the week before`;
}

export interface WeeklyReportInput {
  orgName: string;
  timezone: string;
  start: Date;
  end: Date;
  current: PeriodStats;
  previous: PeriodStats;
}

/** One-page weekly summary email (HTML + plain text). */
export function renderWeeklyReport(input: WeeklyReportInput): { subject: string; html: string; text: string } {
  const { current: c, previous: p } = input;
  const fmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: input.timezone });
  const range = `${fmt.format(input.start)} – ${fmt.format(new Date(input.end.getTime() - 1))}`;
  const count = (n: number) => n.toLocaleString("en-US");

  const rows: Array<[string, string, string]> = [
    [
      "Leads answered",
      `${count(c.answered)} of ${count(c.leads)}`,
      change(c.answered, p.answered, count),
    ],
    ["Calls booked", count(c.booked), change(c.booked, p.booked, count)],
    [
      "Average reply time",
      formatDuration(c.avgReplySeconds),
      change(c.avgReplySeconds, p.avgReplySeconds, formatDuration, true),
    ],
    ["AI cost", formatUsd(c.aiCostUsd), change(c.aiCostUsd, p.aiCostUsd, formatUsd)],
  ];

  const subject = `Your week: ${count(c.answered)} leads answered, ${count(c.booked)} calls booked (${range})`;
  const dashboard = appUrl("/dashboard");

  const html = `<!doctype html><html><body style="margin:0;background:#f8fafc;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #e2e8f0;border-radius:10px">
<tr><td style="padding:28px 28px 8px">
<p style="margin:0;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#1f57c9;font-weight:600">DeskPilot weekly report</p>
<h1 style="margin:8px 0 4px;font-size:22px">${esc(input.orgName)}</h1>
<p style="margin:0;color:#475569;font-size:14px">${esc(range)}</p>
</td></tr>
<tr><td style="padding:16px 28px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
${rows
  .map(
    ([label, value, delta]) => `<tr>
<td style="padding:12px 0;border-top:1px solid #f1f5f9;font-size:14px;color:#475569">${esc(label)}</td>
<td style="padding:12px 0;border-top:1px solid #f1f5f9;font-size:20px;font-weight:600;text-align:right">${esc(value)}</td>
</tr>${delta ? `<tr><td colspan="2" style="padding:0 0 10px;font-size:12px;color:#64748b;text-align:right">${esc(delta)}</td></tr>` : ""}`,
  )
  .join("\n")}
</table>
</td></tr>
<tr><td style="padding:8px 28px 28px">
<a href="${esc(dashboard)}" style="display:inline-block;background:#1f57c9;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:14px;font-weight:600">Open your dashboard</a>
</td></tr>
</table>
<p style="font-size:12px;color:#94a3b8;margin:16px 0 0">You receive this because you own ${esc(input.orgName)} on DeskPilot.</p>
</td></tr></table></body></html>`;

  const text = [
    `DeskPilot weekly report — ${input.orgName}`,
    range,
    "",
    ...rows.map(([label, value, delta]) => `${label}: ${value}${delta ? ` (${delta})` : ""}`),
    "",
    `Dashboard: ${dashboard}`,
  ].join("\n");

  return { subject, html, text };
}
