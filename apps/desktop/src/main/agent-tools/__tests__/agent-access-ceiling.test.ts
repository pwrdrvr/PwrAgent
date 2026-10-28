import { describe, expect, it } from "vitest";
import { checkAgentAccessRequest } from "../agent-access-ceiling";

describe("checkAgentAccessRequest", () => {
  it.each(["auto", "full-access"])(
    "refuses a Default Access caller asking for %s",
    (executionMode) => {
      expect(checkAgentAccessRequest("default", { executionMode })).toEqual({
        code: "forbidden",
        message: expect.stringMatching(
          /more access than this thread has \(Default Access\)\. An agent cannot raise access\. Ask the operator/,
        ),
      });
    },
  );

  it("refuses an Auto caller asking for full-access", () => {
    expect(checkAgentAccessRequest("auto", { executionMode: "full-access" }))
      .toMatchObject({ code: "forbidden" });
  });

  it.each([
    ["default", "default"],
    ["auto", "auto"],
    ["auto", "default"],
    ["full-access", "auto"],
    ["full-access", "full-access"],
  ] as const)("allows a %s caller asking for %s", (caller, executionMode) => {
    expect(checkAgentAccessRequest(caller, { executionMode })).toBeUndefined();
  });

  it("allows a request that names no access", () => {
    expect(checkAgentAccessRequest("default", {})).toBeUndefined();
  });

  it("rejects an unknown mode as invalid", () => {
    expect(checkAgentAccessRequest("full-access", { executionMode: "yolo" }))
      .toMatchObject({ code: "invalid_arguments" });
  });

  it("refuses raw overrides that reach Full Access without naming a mode", () => {
    expect(checkAgentAccessRequest("default", { sandbox: "danger-full-access" }))
      .toMatchObject({ code: "forbidden", message: expect.stringContaining('sandbox="danger-full-access"') });
    expect(checkAgentAccessRequest("auto", { approvalPolicy: "never" }))
      .toMatchObject({ code: "forbidden" });
    expect(checkAgentAccessRequest("default", {
      executionMode: "default",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    })).toBeUndefined();
    expect(checkAgentAccessRequest("full-access", {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    })).toBeUndefined();
  });
});
