import { describe, expect, it } from "vitest";
import type { BackendSummary, ThreadTodoModelSettings } from "@pwragent/shared";
import { todoDispatchRecentResolves } from "../todo-dispatch-model";

const backend = { kind: "codex", available: true, capabilities: { createThread: true }, launchpadOptions: {
  reasoningEfforts: ["low", "medium"], models: [
    { id: "current", current: true, supportsReasoning: true, reasoningEfforts: ["medium", "high"] },
    { id: "plain", supportsReasoning: false }, { id: "fallback" },
    { id: "unknown-efforts", reasoningEfforts: [] },
  ],
} } as BackendSummary;
const recent: ThreadTodoModelSettings = { backend: "codex", model: "current", reasoningEffort: "high" };

describe("dispatch recent compatibility", () => {
  it.each([
    { model: "current", reasoningEffort: "high", valid: true },
    { model: "current", reasoningEffort: "HIGH", valid: true },
    { model: "current", reasoningEffort: "removed", valid: false },
    { model: "plain", reasoningEffort: "medium", valid: false },
    { model: "plain", reasoningEffort: undefined, valid: true },
    { model: "fallback", reasoningEffort: "low", valid: true },
    { model: "fallback", reasoningEffort: "high", valid: false },
    { model: undefined, reasoningEffort: "high", valid: true },
    { model: undefined, reasoningEffort: "low", valid: false },
    { model: "removed-model", reasoningEffort: undefined, valid: false },
    { model: "unknown-efforts", reasoningEffort: "high", valid: true },
  ])("checks model $model and reasoning $reasoningEffort", ({ model, reasoningEffort, valid }) => {
    expect(todoDispatchRecentResolves({ ...recent, model, reasoningEffort }, [backend])).toBe(valid);
  });

  it("hides a recent when catalog updates remove its reasoning effort", () => {
    expect(todoDispatchRecentResolves(recent, [backend])).toBe(true);
    const updated = { ...backend, launchpadOptions: { models: [{ id: "current", reasoningEfforts: ["medium"] }] } };
    expect(todoDispatchRecentResolves(recent, [updated])).toBe(false);
  });

  it("requires an available provider that can start threads", () => {
    expect(todoDispatchRecentResolves(recent, [])).toBe(false);
    expect(todoDispatchRecentResolves(recent, [{ ...backend, available: false }])).toBe(false);
    expect(todoDispatchRecentResolves(recent, [{ ...backend, capabilities: { ...backend.capabilities, createThread: false } }])).toBe(false);
  });
});
