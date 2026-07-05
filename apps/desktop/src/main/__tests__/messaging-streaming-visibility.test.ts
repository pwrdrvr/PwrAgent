import { describe, expect, it } from "vitest";

import { shouldShowStreamingControl } from "../messaging/core/messaging-status-card.js";

describe("shouldShowStreamingControl", () => {
  it("hides the control by default (global off, binding inherits)", () => {
    expect(shouldShowStreamingControl("inherit", false)).toBe(false);
    expect(shouldShowStreamingControl("inherit", undefined)).toBe(false);
  });

  it("hides the control when the binding explicitly disabled streaming", () => {
    expect(shouldShowStreamingControl("disabled", false)).toBe(false);
  });

  it("shows the control when the global option is enabled", () => {
    expect(shouldShowStreamingControl("inherit", true)).toBe(true);
    expect(shouldShowStreamingControl("disabled", true)).toBe(true);
  });

  it("shows the control when the binding already enabled streaming (anti-stranding)", () => {
    expect(shouldShowStreamingControl("enabled", false)).toBe(true);
  });
});
