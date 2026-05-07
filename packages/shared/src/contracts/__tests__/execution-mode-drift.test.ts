import { describe, expect, it } from "vitest";
import {
  executionModeFromCodexResponse,
  isExecutionModeDrifted,
} from "../execution-mode-drift";

describe("isExecutionModeDrifted", () => {
  it("returns true when expected and observed disagree", () => {
    expect(isExecutionModeDrifted("default", "full-access")).toBe(true);
    expect(isExecutionModeDrifted("full-access", "default")).toBe(true);
  });

  it("returns false when both agree", () => {
    expect(isExecutionModeDrifted("default", "default")).toBe(false);
    expect(isExecutionModeDrifted("full-access", "full-access")).toBe(false);
  });

  it("returns false when either side is missing — drift requires both values", () => {
    expect(isExecutionModeDrifted(undefined, "default")).toBe(false);
    expect(isExecutionModeDrifted("default", undefined)).toBe(false);
    expect(isExecutionModeDrifted(undefined, undefined)).toBe(false);
  });
});

describe("executionModeFromCodexResponse", () => {
  it("maps the workspace-write + on-request pair to default", () => {
    expect(
      executionModeFromCodexResponse({
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      }),
    ).toBe("default");
  });

  it("maps the danger-full-access + never pair to full-access", () => {
    expect(
      executionModeFromCodexResponse({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      }),
    ).toBe("full-access");
  });

  it("returns undefined for any combination PwrAgent does not surface", () => {
    expect(
      executionModeFromCodexResponse({
        approvalPolicy: "untrusted",
        sandbox: "workspace-write",
      }),
    ).toBeUndefined();
    expect(
      executionModeFromCodexResponse({
        approvalPolicy: "on-request",
        sandbox: "read-only",
      }),
    ).toBeUndefined();
    expect(
      executionModeFromCodexResponse({
        approvalPolicy: "never",
        sandbox: "workspace-write",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when either side is missing", () => {
    expect(
      executionModeFromCodexResponse({ approvalPolicy: "never" }),
    ).toBeUndefined();
    expect(
      executionModeFromCodexResponse({ sandbox: "danger-full-access" }),
    ).toBeUndefined();
    expect(executionModeFromCodexResponse({})).toBeUndefined();
  });

  it("trims whitespace before classifying", () => {
    expect(
      executionModeFromCodexResponse({
        approvalPolicy: "  on-request  ",
        sandbox: "  workspace-write  ",
      }),
    ).toBe("default");
  });
});
