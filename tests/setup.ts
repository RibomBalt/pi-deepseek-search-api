import { afterEach, beforeEach, vi } from "vitest";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected network access from a unit test");
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});
