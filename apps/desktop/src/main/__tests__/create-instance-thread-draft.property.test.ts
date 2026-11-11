import fc from "fast-check";
import type { BackendModelOption, NavigationLaunchpadConfigResponse } from "@pwragent/shared";
import { expect, it } from "vitest";
import { assertThreadModelSettingsAvailable } from "../app-server/thread-model-admission";
import { buildLaunchpadDraft } from "../federation/federation-agent-tools-service";

// The owner admits every launchpad setting it receives as a request. Its own
// admission check is the oracle: a draft built for a named model must never
// carry an inherited setting that check refuses.
const EFFORTS = ["none", "low", "medium", "high", "max"];
const effortMenu = fc.subarray(EFFORTS, { minLength: 1 });
const modelOption: fc.Arbitrary<BackendModelOption> = fc.oneof(
  fc.record({ supportsFast: fc.boolean() }).map((fields) => ({
    id: "@refuseless/glm-5.3-abliterated",
    supportsReasoning: false,
    ...fields,
  })),
  fc.record({ reasoningEfforts: effortMenu, supportsFast: fc.boolean() }).map((fields) => ({
    id: "gpt-6-luna",
    supportsReasoning: true,
    ...fields,
  })),
);
const inherited = fc.record({
  reasoningEffort: fc.option(fc.constantFrom(...EFFORTS), { nil: undefined }),
  fastMode: fc.option(fc.boolean(), { nil: undefined }),
});

function config(saved: { reasoningEffort?: string; fastMode?: boolean }, fromLaunchpad: boolean): NavigationLaunchpadConfigResponse {
  const settings = { backend: "codex" as const, executionMode: "auto" as const, model: "gpt-5.6-terra", ...saved };
  return {
    protocol: 2,
    revision: "r1",
    directoryKey: "directory:/repo",
    defaults: fromLaunchpad ? { backend: "codex", executionMode: "auto", model: "gpt-5.6-terra" } : settings,
    ...(fromLaunchpad ? { launchpad: { ...settings, directoryKey: "directory:/repo", directoryKind: "directory", directoryLabel: "repo", prompt: "" } } : {}),
  } as NavigationLaunchpadConfigResponse;
}

const directory = { key: "directory:/repo", kind: "directory", label: "repo", path: "/repo" } as never;

it("a named model never inherits a reasoning effort or Fast setting its owner refuses", () => {
  fc.assert(fc.property(modelOption, inherited, fc.boolean(), (option, saved, fromLaunchpad) => {
    const draft = buildLaunchpadDraft({
      config: config(saved, fromLaunchpad),
      directory,
      args: { instanceId: "pwr_outpost", projectKey: "directory:/repo", model: option.id },
      modelOption: option,
    });
    expect(draft.model).toBe(option.id);
    expect(() => assertThreadModelSettingsAvailable("codex", { models: [option] }, {
      model: draft.model,
      reasoningEffort: draft.reasoningEffort,
      fastMode: draft.fastMode,
    })).not.toThrow();
    // An inherited setting the model accepts is kept, not discarded.
    if (saved.reasoningEffort !== undefined && option.supportsReasoning && option.reasoningEfforts?.includes(saved.reasoningEffort)) {
      expect(draft.reasoningEffort).toBe(saved.reasoningEffort);
    }
  }));
});

it("explicit settings reach the owner unchanged, even ones it will refuse", () => {
  fc.assert(fc.property(modelOption, inherited, fc.constantFrom(...EFFORTS), fc.boolean(), (option, saved, effort, fastMode) => {
    const draft = buildLaunchpadDraft({
      config: config(saved, true),
      directory,
      args: { instanceId: "pwr_outpost", projectKey: "directory:/repo", model: option.id, reasoningEffort: effort, fastMode },
      modelOption: option,
    });
    expect(draft.reasoningEffort).toBe(effort);
    expect(draft.fastMode).toBe(fastMode);
  }));
});
