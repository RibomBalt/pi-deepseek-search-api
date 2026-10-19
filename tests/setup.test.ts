import { describe, expect, it } from "vitest";

describe("test harness", () => {
  it("runs in the Node environment", () => {
    expect(typeof process.versions.node).toBe("string");
  });
});
