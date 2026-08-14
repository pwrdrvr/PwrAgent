import { describe, expect, it } from "vitest";
import { shouldWriteSystemClipboard } from "../../preload/clipboard-policy";

describe("clipboard policy", () => {
  it("writes to the system clipboard outside E2E", () => {
    expect(shouldWriteSystemClipboard({})).toBe(true);
  });

  it("keeps local E2E writes off the system clipboard", () => {
    expect(shouldWriteSystemClipboard({ PWRAGENT_E2E: "1" })).toBe(false);
  });

  it.each(["1", "true"])(
    "allows isolated CI E2E to exercise the system clipboard with CI=%s",
    (CI) => {
      expect(shouldWriteSystemClipboard({ CI, PWRAGENT_E2E: "1" })).toBe(true);
    },
  );
});
