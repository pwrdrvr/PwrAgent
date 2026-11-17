import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { messageOriginForInboundEvent, normalizeMonitorCommandAction, parseDefaultAgentScopeKind, parseMonitorBooleanArg, parseMonitorCountArg, parseMonitorIntervalArg, parseMonitorStatusLineArg, readStringValue, scheduledActionFailureMessage } from "../messaging/core/messaging-command-helpers";
import { commandEvent } from "./fixtures/messaging-command-harness";

describe("messaging command helpers", () => {
  it("preserves the requested monitor units and explicit zero counts", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 500 }), fc.constantFrom("s", "m"), (value, unit) => {
      const expected = value * (unit === "m" ? 60_000 : 1_000);
      expect(parseMonitorIntervalArg(` ${value}${unit} `)).toBe(expected);
      expect(normalizeMonitorCommandAction(["interval", `${value}${unit}`])).toEqual({ kind: "set-interval", intervalMs: expected });
      expect(parseMonitorCountArg(String(value))).toBe(value);
      expect(normalizeMonitorCommandAction(["pins", String(value)])).toEqual({ kind: "set-pinned", count: value });
      expect(normalizeMonitorCommandAction(["recent", String(value)])).toEqual({ kind: "set-recent", count: value });
    }));
  });

  it("normalizes the independent alias catalog", () => {
    const aliases = [
      ["stop", "stop"], ["off", "stop"], ["disable", "stop"], ["refresh", "refresh"], ["now", "refresh"],
      ["interval", "cycle-interval"], ["pins", "cycle-pinned"], ["recent", "cycle-recent"],
      ["snippet", "toggle-snippet"], ["details", "toggle-status-line"],
    ] as const;
    fc.assert(fc.property(fc.constantFrom(...aliases), ([arg, kind]) => {
      expect(normalizeMonitorCommandAction([` ${arg.toUpperCase()} `])).toEqual({ kind });
    }));
    expect(normalizeMonitorCommandAction(["topics", "cleanup"])).toEqual({ kind: "topics-cleanup" });
    expect(normalizeMonitorCommandAction(["topics", "fanout"])).toEqual({ kind: "topics-fanout" });
    expect(normalizeMonitorCommandAction(["topics"])).toEqual({ kind: "topics-adopt" });
    expect(normalizeMonitorCommandAction(undefined)).toEqual({ kind: "start" });
    for (const [word, expected] of [["on", true], ["yes", true], ["true", true], ["off", false], ["false", false], ["no", false]] as const) {
      expect(parseMonitorBooleanArg(word)).toBe(expected);
      expect(parseMonitorStatusLineArg(word)).toBe(expected);
    }
    expect(parseMonitorStatusLineArg("lines")).toBe(true);
    expect(parseMonitorStatusLineArg("inline")).toBe(false);
    expect(parseMonitorBooleanArg("invalid")).toBeUndefined();
    expect(parseMonitorIntervalArg("invalid")).toBeUndefined();
  });

  it("keeps message attribution, scopes, and JSON strings exact", () => {
    fc.assert(fc.property(fc.string(), text => {
      const event = commandEvent("schedule");
      const origin = messageOriginForInboundEvent({ ...event, sourceUrl: text, actor: { ...event.actor, displayName: text } });
      expect(origin).toMatchObject({ kind: "messaging", messaging: {
        platform: "telegram", actor: { platformUserId: "actor", ...(text ? { displayName: text } : {}) },
        surface: { id: "source", kind: "dm" }, ...(text ? { sourceUrl: text } : {}),
      } });
      expect(readStringValue({ value: text }, "value")).toBe(text);
      expect(readStringValue({ value: 1 }, "value")).toBeUndefined();
      expect(readStringValue([text], "value")).toBeUndefined();
    }));
    expect(messageOriginForInboundEvent(undefined)).toEqual({ kind: "messaging" });
    for (const scope of ["conversation", "parent", "workspace", "provider", "profile"]) {
      expect(parseDefaultAgentScopeKind(` ${scope.toUpperCase()} `)).toBe(scope);
    }
    expect(parseDefaultAgentScopeKind("other")).toBeUndefined();
    const action = { id: "action", backend: "codex" as const, threadId: "thread", kind: "turn" as const, origin: "messaging" as const, status: "scheduled" as const, scheduledFor: 1_000, displayText: "Fixture", createdAt: 1_000, updatedAt: 1_000 };
    expect(scheduledActionFailureMessage(action)).toBeUndefined();
    expect(scheduledActionFailureMessage({ ...action, status: "failed", errorMessage: "Fixture rejection" })).toBe("Fixture rejection");
    expect(scheduledActionFailureMessage({ ...action, status: "failed" })).toBe("The scheduled action could not be dispatched.");
  });
});
