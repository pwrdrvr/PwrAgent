import { describe, expect, it } from "vitest";
import type { AppServerPendingRequestNotification } from "../contracts/normalized-app-server";
import {
  buildPendingRequestActions,
  buildPendingRequestResponse,
} from "../pending-request-response";

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

  it("exposes structured execpolicy amendment decisions", () => {
    const structuredDecision = {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ["pnpm", "test"],
      },
    };
    const request = createRequest({
      params: {
        threadId: "thread-1",
        requestId: "request-1",
        availableDecisions: ["accept", structuredDecision, "cancel"],
      },
    });

    const actions = buildPendingRequestActions(request);

    expect(actions).toEqual([
      expect.objectContaining({
        decision: "accept",
        label: "Approve Once",
      }),
      expect.objectContaining({
        decision: "accept_with_execpolicy_amendment",
        label: "Approve Prefix: pnpm test",
        response: { decision: structuredDecision },
      }),
      expect.objectContaining({
        decision: "cancel",
      }),
    ]);
    expect(buildPendingRequestResponse(request, actions[1]!)).toEqual({
      decision: structuredDecision,
    });
  });

  it("labels network policy amendment decisions", () => {
    const allowHost = {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: {
          host: "api.example.com",
          action: "allow",
        },
      },
    };
    const denyHost = {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: {
          host: "api.example.com",
          action: "deny",
        },
      },
    };
    const request = createRequest({
      params: {
        threadId: "thread-1",
        requestId: "request-1",
        availableDecisions: [allowHost, denyHost],
      },
    });

    expect(buildPendingRequestActions(request)).toEqual([
      expect.objectContaining({
        decision: "apply_network_policy_amendment",
        label: "Allow api.example.com",
        style: "primary",
      }),
      expect.objectContaining({
        decision: "apply_network_policy_amendment",
        label: "Block api.example.com",
        style: "danger",
      }),
    ]);
  });
});
