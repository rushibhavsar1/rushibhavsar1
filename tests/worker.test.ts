import { describe, expect, it } from "vitest";
import { JOB_NAMES } from "@/lib/queue";
import { handlers } from "@/worker/handlers";

describe("worker", () => {
  it("has a handler for every queue (no job is left unprocessed)", () => {
    expect(Object.keys(handlers).sort()).toEqual([...JOB_NAMES].sort());
  });
});
