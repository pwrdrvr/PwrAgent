import { describe, expect, it } from "vitest";
import type { AppServerPendingRequestNotification } from "../contracts/normalized-app-server";
import { buildPendingRequestResponse } from "../pending-request-response";

function createRequest(
  overrides: Partial<AppServerPendingRequestNotification> = {},
): AppServerPendingRequestNotification {
  return {
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      requestId: "request-1",
      ...("params" in overrides ? overrides.params : {}),
    },
    ...overrides,
  } as AppServerPendingRequestNotification;
}

describe("buildPendingRequestResponse", () => {
  it("uses an explicit approve decision when available", () => {
    const request = createRequest({
      params: {
        threadId: "thread-1",
        requestId: "request-1",
        availableDecisions: ["approve", "reject"],
      },
    });

    expect(buildPendingRequestResponse(request, "approve")).toEqual({
      decision: "approve",
    });
  });

  it("maps approve to accept when that alias is provided", () => {
    const request = createRequest({
      params: {
        threadId: "thread-1",
        requestId: "request-1",
        availableDecisions: ["accept", "decline"],
      },
    });

    expect(buildPendingRequestResponse(request, "approve")).toEqual({
      decision: "accept",
    });
  });

  it("falls back to legacy command approval semantics without explicit decisions", () => {
    const request = createRequest();

    expect(buildPendingRequestResponse(request, "approve")).toEqual({
      decision: "accept",
    });
  });

  it("reads structured decision descriptors", () => {
    const request = createRequest({
      params: {
        threadId: "thread-1",
        requestId: "request-1",
        decisions: [{ value: "allow" }, { value: "deny" }],
      },
    });

    expect(buildPendingRequestResponse(request, "approve")).toEqual({
      decision: "allow",
    });
  });
});
