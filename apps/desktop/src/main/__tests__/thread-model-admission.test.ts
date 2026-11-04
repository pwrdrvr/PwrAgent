import { describe, expect, it } from "vitest";
import type { BackendLaunchpadOptions } from "@pwragent/shared";
import { assertThreadModelSettingsAvailable } from "../app-server/thread-model-admission";

const options: BackendLaunchpadOptions = { models: [
  { id: "gpt-6.1-terra", supportsReasoning: true, reasoningEfforts: ["low", "high"], supportsFast: true,
    serviceTiers: ["default", "priority", "ultrafast"] },
  { id: "@fixture/custom", supportsReasoning: false, reasoningEfforts: [], supportsFast: false },
] };

describe("thread model admission", () => {
  it.each([
    {},
    { model: "gpt-6.1-terra", reasoningEffort: "high", fastMode: true, serviceTier: "priority" },
    { model: "gpt-6.1-terra", serviceTier: "fast" },
    { model: "gpt-6.1-terra", serviceTier: "ultrafast", fastMode: false },
    { model: "@fixture/custom", fastMode: false },
  ])("accepts advertised selections and omitted defaults: %j", (requested) => {
    expect(() => assertThreadModelSettingsAvailable("codex", options, requested, "gpt-6.1-terra")).not.toThrow();
  });

  it.each([
    { model: "Terra" },
    { model: "" },
    { model: "missing" },
    { reasoningEffort: "ultra" },
    { model: "@fixture/custom", reasoningEffort: "high" },
    { model: "@fixture/custom", serviceTier: "priority" },
    { model: "@fixture/custom", fastMode: true },
    { serviceTier: "unknown" },
  ])("rejects unavailable choices with actionable choices: %j", (requested) => {
    expect(() => assertThreadModelSettingsAvailable("codex", options, requested, "gpt-6.1-terra"))
      .toThrow(/Available|Omit/);
  });

  it.each([undefined, { models: [] }])("refuses an explicit model when discovery has no catalog: %j", (catalog) => {
    expect(() => assertThreadModelSettingsAvailable("acp:fixture", catalog, { model: "gpt-6.1-terra" }))
      .toThrow(/none discovered; refresh the provider catalog and retry/);
    expect(() => assertThreadModelSettingsAvailable("acp:fixture", catalog, {})).not.toThrow();
  });

  it("checks effort against the selected model rather than another model's levels", () => {
    expect(() => assertThreadModelSettingsAvailable("claude", { models: [
      { id: "opus", supportsReasoning: true, reasoningEfforts: ["default", "high", "max"] },
      { id: "sonnet", supportsReasoning: true, reasoningEfforts: ["default", "high"] },
    ], reasoningEfforts: ["default", "high", "max"] }, { model: "sonnet", reasoningEffort: "max" }))
      .toThrow('Available reasoning efforts: default, high');
  });

  it("refuses a non-boolean Fast flag from an untyped request", () => {
    expect(() => assertThreadModelSettingsAvailable("codex", options, { fastMode: "true" as never }, "gpt-6.1-terra"))
      .toThrow("Pass true or false");
  });
});
