import { afterEach, describe, expect, it } from "vitest";
import { env, requireEnv, resetEnvCache } from "@/lib/env";

describe("env", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    resetEnvCache();
  });

  it("applies defaults and treats empty strings as unset", () => {
    process.env.STRIPE_SECRET_KEY = "";
    resetEnvCache();
    expect(env().WORKER_CONCURRENCY).toBe(4);
    expect(env().STRIPE_SECRET_KEY).toBeUndefined();
  });

  it("requireEnv names the missing variable", () => {
    delete process.env.RESEND_API_KEY;
    resetEnvCache();
    expect(() => requireEnv("RESEND_API_KEY")).toThrow(/RESEND_API_KEY/);
  });
});
