import type { Organization } from "@/server/types";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const URL_RE = /\bhttps:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/g;

/** Plain-text email body -> simple, safe HTML (paragraphs, line breaks, https links). */
export function textToHtml(text: string): string {
  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const linked = escapeHtml(p).replace(URL_RE, (url) => `<a href="${url}">${url}</a>`);
      return `<p style="margin:0 0 16px">${linked.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">\n${paragraphs}\n</body></html>`;
}

/** "Maria at Bright Smile <hello@brightsmile.com>", with the display name sanitised. */
export function fromAddress(org: Pick<Organization, "name" | "from_name" | "from_local_part" | "sending_domain">): string {
  if (!org.sending_domain) throw new Error("No sending domain");
  const display = (org.from_name || org.name).replace(/["<>\r\n\\]/g, "").trim().slice(0, 80);
  return `"${display}" <${org.from_local_part}@${org.sending_domain}>`;
}

/** Stable Message-ID for a draft so follow-ups thread under the first email. */
export function messageIdFor(draftId: string, domain: string): string {
  return `<${draftId}@${domain}>`;
}
