// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const WIDGET = readFileSync(join(process.cwd(), "public", "widget.js"), "utf8");
const ORG_KEY = "a".repeat(32);

function mountWidget(attrs: Record<string, string> = {}) {
  const script = document.createElement("script");
  script.setAttribute("data-org", ORG_KEY);
  for (const [k, v] of Object.entries(attrs)) script.setAttribute(k, v);
  Object.defineProperty(script, "src", { value: "https://app.deskpilot.test/widget.js" });
  document.body.appendChild(script);
  Object.defineProperty(document, "currentScript", { value: script, configurable: true });
  // Run the widget source as the browser would.
  new Function(WIDGET)();
  const host = document.querySelector(".deskpilot-widget") as HTMLElement;
  return host.shadowRoot!;
}

function fill(root: ShadowRoot, name: string, value: string) {
  const el = root.querySelector(`[name="${name}"]`) as HTMLInputElement;
  el.value = value;
}

describe("widget.js", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("renders a contact form and posts the lead to the intake endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 201, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);

    const root = mountWidget({ "data-title": "Contact us" });
    expect(root.querySelector("h3")?.textContent).toBe("Contact us");

    fill(root, "name", "Jane");
    fill(root, "email", "jane@example.com");
    fill(root, "message", "Do you have time next week?");
    root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(root.querySelector(".msg")?.textContent).toMatch(/Thanks/));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://app.deskpilot.test/api/leads/${ORG_KEY}`);
    expect(JSON.parse(init.body)).toEqual({
      name: "Jane",
      email: "jane@example.com",
      message: "Do you have time next week?",
      source: "form",
    });
    expect(init.credentials).toBe("omit");
  });

  it("shows field errors from the server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 422,
        json: async () => ({ error: "Please check the form", fields: { email: "Enter a valid email address" } }),
      }),
    );
    const root = mountWidget();
    fill(root, "email", "bad@x");
    fill(root, "message", "hi");
    root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() =>
      expect(root.querySelector('.err[data-for="email"]')?.textContent).toBe("Enter a valid email address"),
    );
  });
});
