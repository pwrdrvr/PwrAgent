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

  it("keeps the control visible for a thread that had streaming on, after it is turned off", () => {
    // streamingControlRevealed sticks once streaming has been enabled, so the
    // control stays reachable even when the current mode is off/inherit and the
    // global setting is off.
    expect(shouldShowStreamingControl("disabled", false, true)).toBe(true);
    expect(shouldShowStreamingControl("inherit", false, true)).toBe(true);
  });

  it("does not reveal the control for a thread that never had streaming on", () => {
    expect(shouldShowStreamingControl("disabled", false, false)).toBe(false);
    expect(shouldShowStreamingControl("inherit", false, undefined)).toBe(false);
  });
});
