import { describe, expect, it } from "vitest";
import type { BackendLaunchpadOptions } from "@pwragent/shared";
import { resolveThreadTodoModel } from "../thread-todos/thread-todo-models";

const OPTIONS: BackendLaunchpadOptions = {
  models: [
    {
      id: "gpt-6.1",
      label: "GPT-6.1",
      current: true,
      supportsReasoning: true,
      reasoningEfforts: ["low", "medium", "high"],
    },
    {
      id: "gpt-6.1-sol",
      label: "GPT-6.1-Sol",
      supportsReasoning: true,
      reasoningEfforts: ["low", "medium", "high", "xhigh"],
    },
    { id: "swift-mini", label: "Swift Mini", supportsReasoning: false },
  ],
};

describe("resolveThreadTodoModel", () => {
  it("takes a model by display name or loose spelling and stores its id", () => {
    expect(resolveThreadTodoModel(OPTIONS, { model: "GPT-6.1-Sol", reasoningEffort: "xhigh" }))
      .toEqual({ ok: true, model: "gpt-6.1-sol", reasoningEffort: "xhigh" });
    expect(resolveThreadTodoModel(OPTIONS, { model: "gpt 6.1 sol" }))
      .toEqual({ ok: true, model: "gpt-6.1-sol" });
  });

  it("refuses a model the catalog does not list instead of letting it fall back", () => {
    const resolved = resolveThreadTodoModel(OPTIONS, { model: "gpt-7" });
    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.message).toContain("gpt-6.1-sol (GPT-6.1-Sol)");
  });

  it("checks an effort against the model the card will run on", () => {
    // The default model offers no xhigh.
    expect(resolveThreadTodoModel(OPTIONS, { reasoningEffort: "xhigh" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("low, medium, high"),
    });
    expect(resolveThreadTodoModel(OPTIONS, { reasoningEffort: "HIGH" }))
      .toEqual({ ok: true, reasoningEffort: "high" });
    expect(resolveThreadTodoModel(OPTIONS, { model: "swift-mini", reasoningEffort: "high" }))
      .toMatchObject({ ok: false, message: "swift-mini (Swift Mini) does not take a reasoning effort." });
  });

  it("passes values through when the catalog is empty", () => {
    expect(resolveThreadTodoModel({ models: [] }, { model: "anything", reasoningEffort: "max" }))
      .toEqual({ ok: true, model: "anything", reasoningEffort: "max" });
  });
});
