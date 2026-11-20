import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import {
  assistantTextForBackendEvent,
  bindingMatchesFederationTarget,
  isTerminalTurnLifecycle,
  turnLifecycleForBackendEvent,
} from "../messaging/core/messaging-backend-event-helpers";
import type { MessagingBindingRecord } from "@pwragent/messaging-interface";

describe("messaging backend event helpers", () => {
  it("uses the protocol terminal status, including interruption reported as completion", () => {
    fc.assert(fc.property(fc.constantFrom("completed" as const, "interrupted" as const), fc.nat(), (status, now) => {
      const event: AgentEvent = { backend: "codex", notification: { method: "turn/completed", params: {
        threadId: "thread", turnId: "turn", turn: { id: "turn", status, output: [] },
      } } };
      expect(turnLifecycleForBackendEvent(event, now)).toEqual({ turnId: "turn", status, startedAt: undefined, updatedAt: now });
      expect(isTerminalTurnLifecycle(turnLifecycleForBackendEvent(event, now))).toBe(true);
    }));
  });

  it("keeps the final output from a completed turn independent of lifecycle state", () => {
    const event: AgentEvent = { backend: "claude", notification: { method: "turn/completed", params: {
      threadId: "thread", turnId: "turn", turn: { id: "turn", status: "completed", output: [
        { type: "text", text: "Interim" }, { type: "text", text: "Final answer" },
      ] },
    } } };
    expect(assistantTextForBackendEvent(event)).toBe("Final answer");
  });

  it("requires the binding's owning instance for a federated event", () => {
    const local: MessagingBindingRecord = {
      id: "binding", backend: "codex", threadId: "thread", authorizedActorIds: [], createdAt: 1, updatedAt: 1,
      channel: { channel: "telegram", conversation: { id: "fixture", kind: "dm" } },
    };
    const remote: MessagingBindingRecord = { ...local, federatedThread: {
      backend: "codex", threadId: "thread", target: { scope: "remote", instanceId: "owner" },
    } };
    expect(bindingMatchesFederationTarget(local, undefined)).toBe(true);
    expect(bindingMatchesFederationTarget(local, { scope: "remote", instanceId: "owner" })).toBe(false);
    expect(bindingMatchesFederationTarget(remote, { scope: "remote", instanceId: "other" })).toBe(false);
    expect(bindingMatchesFederationTarget(remote, { scope: "remote", instanceId: "owner" })).toBe(true);
  });
});
