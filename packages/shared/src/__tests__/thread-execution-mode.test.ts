import { describe, expect, it } from "vitest";
import {
  isThreadExecutionMode,
  lowerThreadExecutionMode,
  THREAD_EXECUTION_MODES_BY_ACCESS,
  threadExecutionModeExceeds,
  threadExecutionModeForRawPermissions,
  threadExecutionModeRank,
} from "../thread-execution-mode";

describe("thread execution mode rank", () => {
  it("orders default < auto < full-access", () => {
    expect(THREAD_EXECUTION_MODES_BY_ACCESS).toEqual(["default", "auto", "full-access"]);
    expect(threadExecutionModeRank("default")).toBeLessThan(threadExecutionModeRank("auto"));
    expect(threadExecutionModeRank("auto")).toBeLessThan(threadExecutionModeRank("full-access"));
  });

  it("treats only a higher mode as exceeding", () => {
    expect(threadExecutionModeExceeds("auto", "default")).toBe(true);
    expect(threadExecutionModeExceeds("full-access", "auto")).toBe(true);
    expect(threadExecutionModeExceeds("auto", "auto")).toBe(false);
    expect(threadExecutionModeExceeds("default", "full-access")).toBe(false);
  });

  it("picks the mode with less access", () => {
    expect(lowerThreadExecutionMode("full-access", "auto")).toBe("auto");
    expect(lowerThreadExecutionMode("default", "auto")).toBe("default");
    expect(lowerThreadExecutionMode("auto", "auto")).toBe("auto");
  });

  it("recognizes only the three modes", () => {
    expect(isThreadExecutionMode("full-access")).toBe(true);
    expect(isThreadExecutionMode("Full Access")).toBe(false);
    expect(isThreadExecutionMode(undefined)).toBe(false);
  });

  it("ranks raw permission overrides by the access they grant", () => {
    expect(threadExecutionModeForRawPermissions({})).toBe("default");
    expect(threadExecutionModeForRawPermissions({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    })).toBe("default");
    expect(threadExecutionModeForRawPermissions({
      approvalPolicy: "untrusted",
      sandbox: "read-only",
    })).toBe("default");
    expect(threadExecutionModeForRawPermissions({ approvalPolicy: "never" })).toBe("full-access");
    expect(threadExecutionModeForRawPermissions({ approvalPolicy: "on-failure" })).toBe("full-access");
    expect(threadExecutionModeForRawPermissions({ sandbox: "danger-full-access" })).toBe("full-access");
    // An unknown value is not proof of less access.
    expect(threadExecutionModeForRawPermissions({ sandbox: "granular" })).toBe("full-access");
  });
});
