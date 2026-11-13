import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/urls";

describe("safeNextPath", () => {
  it("allows relative paths", () => {
    expect(safeNextPath("/inbox")).toBe("/inbox");
    expect(safeNextPath("/leads?status=new")).toBe("/leads?status=new");
  });

  it("blocks open redirects", () => {
    for (const bad of [
      "https://evil.com",
      "//evil.com",
      "/\\evil.com",
      "/\t/evil.example/phish", // browsers drop the tab -> //evil.example
      "/\n/evil.example",
      "/ /evil.example",
      "/%09/evil.example",
      "javascript:alert(1)",
      "",
    ]) {
      const result = safeNextPath(bad);
      expect(new URL(result, "https://app.example").origin, JSON.stringify(bad)).toBe("https://app.example");
    }
    expect(safeNextPath("/\t/evil.example/phish")).toBe("/dashboard");
    expect(safeNextPath(null)).toBe("/dashboard");
  });
});
