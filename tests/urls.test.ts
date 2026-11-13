import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/urls";

describe("safeNextPath", () => {
  it("allows relative paths", () => {
    expect(safeNextPath("/inbox")).toBe("/inbox");
  });
  it("blocks open redirects", () => {
    expect(safeNextPath("https://evil.com")).toBe("/dashboard");
    expect(safeNextPath("//evil.com")).toBe("/dashboard");
    expect(safeNextPath("/\\evil.com")).toBe("/dashboard");
    expect(safeNextPath(null)).toBe("/dashboard");
  });
});
