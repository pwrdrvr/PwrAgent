import { describe, expect, it } from "vitest";
import type { AppServerPendingRequestNotification } from "../contracts/normalized-app-server";
import {
  buildPendingRequestActions,
  buildPendingRequestApprovalContext,
  buildPendingRequestResponse,
  formatApprovalPath,
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

  it("keeps legacy option labels while submitting normalized decisions", () => {
    const request = createRequest({
      method: "turn/requestApproval",
      params: {
        threadId: "thread-1",
        requestId: "request-1",
        options: ["Approve Once", "Cancel"],
      },
    });

    const actions = buildPendingRequestActions(request);

    expect(actions).toEqual([
      expect.objectContaining({
        label: "Approve Once",
        response: { decision: "accept" },
      }),
      expect.objectContaining({
        label: "Cancel",
        response: { decision: "cancel" },
      }),
    ]);
    expect(buildPendingRequestResponse(request, actions[0]!)).toEqual({
      decision: "accept",
    });
  });

  it("includes the advertised command approval replies in fallback actions", () => {
    const request = createRequest();

    expect(buildPendingRequestActions(request)).toEqual([
      expect.objectContaining({
        decision: "accept",
        fallbackText: "1",
      }),
      expect.objectContaining({
        decision: "accept_for_session",
        fallbackText: "2",
      }),
      expect.objectContaining({
        decision: "decline",
        fallbackText: "3",
      }),
      expect.objectContaining({
        decision: "cancel",
        fallbackText: "4",
      }),
    ]);
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
        label: "Always Allow Prefix: pnpm test",
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

  it("assigns unique ids to structured amendment decisions", () => {
    const firstPrefix = {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ["pnpm", "test"],
      },
    };
    const secondPrefix = {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ["pnpm", "lint"],
      },
    };
    const firstHost = {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: {
          host: "api.example.com",
          action: "allow",
        },
      },
    };
    const secondHost = {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: {
          host: "cdn.example.com",
          action: "allow",
        },
      },
    };
    const request = createRequest({
      params: {
        threadId: "thread-1",
        requestId: "request-1",
        availableDecisions: [firstPrefix, secondPrefix, firstHost, secondHost],
      },
    });

    const actions = buildPendingRequestActions(request);

    expect(new Set(actions.map((action) => action.id)).size).toBe(actions.length);
    expect(buildPendingRequestResponse(request, actions[1]!)).toEqual({
      decision: secondPrefix,
    });
    expect(buildPendingRequestResponse(request, actions[3]!)).toEqual({
      decision: secondHost,
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

describe("buildPendingRequestApprovalContext", () => {
  it("formats file-change paths relative to known thread directories", () => {
    const request = createRequest({
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "thread-1",
        requestId: "request-1",
        action: "write",
        path: "/repo/pwragent/apps/desktop/PR_DESCRIPTION.md",
        grantRoot: "/repo/pwragent",
      },
    });

    expect(
      buildPendingRequestApprovalContext(request, {
        directoryPaths: ["/repo/pwragent"],
      }),
    ).toMatchObject({
      action: "write",
      path: "/repo/pwragent/apps/desktop/PR_DESCRIPTION.md",
      displayPath: "apps/desktop/PR_DESCRIPTION.md",
      grantRoot: "/repo/pwragent",
      displayGrantRoot: ".",
    });
  });

  it("keeps absolute paths when they are outside known thread directories", () => {
    expect(formatApprovalPath("/tmp/PR_DESCRIPTION.md", ["/repo/pwragent"])).toBe(
      "/tmp/PR_DESCRIPTION.md",
    );
  });
});
