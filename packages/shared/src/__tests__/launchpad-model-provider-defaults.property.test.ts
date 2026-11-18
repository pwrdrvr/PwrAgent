import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyNavigationLaunchpadProviderExecutionModeDefaults,
  applyNavigationLaunchpadDefaultsPatch,
  applyNavigationLaunchpadProviderModelDefaults,
  applyNavigationLaunchpadProviderSettingsPatch,
  changedProviderExecutionModeDefaultBackends,
  changedProviderModelDefaultBackends,
  providerPickerValue,
  navigationLaunchpadProviderKey,
  normalizeModelProviderDefaults,
  projectNavigationLaunchpadProviderSettings,
  type DesktopProviderModelDefaults,
  type NavigationLaunchpadDefaults,
} from "../index";

const provider = fc.constantFrom("mathos", "bonsai");
const effort = fc.constantFrom("low", "medium", "high");
const access = fc.constantFrom("auto" as const, "default" as const, "full-access" as const);

describe("launchpad model-provider isolation", () => {
  it("files an inactive provider's access-only sticky choice without changing the active provider", () => {
    fc.assert(fc.property(provider, access, (id, mode) => {
      const current: NavigationLaunchpadDefaults = {
        backend: "codex", model: `@${id}/one`, executionMode: "default",
      };
      const updated = applyNavigationLaunchpadDefaultsPatch(current, { executionMode: mode }, "codex");
      expect(updated).toMatchObject({ model: `@${id}/one`, executionMode: "default" });
      expect(updated.providerSettings?.codex?.executionMode).toBe(mode);
    }));
  });

  it("agrees with a per-provider memory model over arbitrary switching and editing sequences", () => {
    fc.assert(fc.property(fc.array(fc.record({
      key: fc.constantFrom("codex", "codex-provider:mathos", "codex-provider:bonsai"),
      modelIndex: fc.integer({ min: 0, max: 2 }), effort, access,
    }), { minLength: 1, maxLength: 25, size: "max" }), (steps) => {
      let launchpad: NavigationLaunchpadDefaults = {
        backend: "codex", model: "gpt-0", reasoningEffort: "low", executionMode: "auto",
      };
      const memory = new Map<string, { model: string; reasoningEffort: string; executionMode: string }>([
        ["codex", { model: "gpt-0", reasoningEffort: "low", executionMode: "auto" }],
      ]);
      for (const step of steps) {
        const id = step.key === "codex" ? undefined : step.key.slice("codex-provider:".length);
        launchpad = applyNavigationLaunchpadProviderSettingsPatch(launchpad, { backend: "codex", codexModelProviderId: id });
        expect(navigationLaunchpadProviderKey(launchpad)).toBe(step.key);
        expect(launchpad.model).toBe(memory.get(step.key)?.model);
        expect(launchpad.reasoningEffort).toBe(memory.get(step.key)?.reasoningEffort);
        expect(launchpad.executionMode).toBe(memory.get(step.key)?.executionMode ?? "auto");
        const model = id ? `@${id}/model-${step.modelIndex}` : `gpt-${step.modelIndex}`;
        launchpad = applyNavigationLaunchpadProviderSettingsPatch(launchpad, {
          model, reasoningEffort: step.effort, executionMode: step.access,
        });
        memory.set(step.key, { model, reasoningEffort: step.effort, executionMode: step.access });
      }
    }));
  });

  it("changing any provider's defaults preserves every other provider's active choices", () => {
    fc.assert(fc.property(provider, effort, access, fc.boolean(), (id, reasoning, mode, updateOpenAI) => {
      const customModel = `@${id}/model`;
      const customKey = providerPickerValue("codex", customModel);
      const activeKey = updateOpenAI ? customKey : "codex";
      const changedKey = updateOpenAI ? "codex" : customKey;
      const launchpad: NavigationLaunchpadDefaults = {
        backend: "codex",
        model: updateOpenAI ? customModel : "gpt-test",
        reasoningEffort: reasoning,
        executionMode: mode,
      };
      const defaults: Record<string, DesktopProviderModelDefaults> = {
        [changedKey]: {
          model: updateOpenAI ? "gpt-next" : `@${id}/next`,
          reasoningEffortsByModel: {},
          executionMode: mode === "auto" ? "full-access" : "auto",
        },
      };
      const updated = applyNavigationLaunchpadProviderExecutionModeDefaults(
        applyNavigationLaunchpadProviderModelDefaults(
          launchpad, defaults, changedProviderModelDefaultBackends({}, defaults), true,
        ),
        defaults, changedProviderExecutionModeDefaultBackends({}, defaults), true,
      );
      expect(providerPickerValue(updated.backend, updated.model)).toBe(activeKey);
      expect(updated).toMatchObject({
        model: launchpad.model,
        reasoningEffort: reasoning,
        executionMode: mode,
      });
    }));
  });

  it("restores each provider's model, reasoning memory, and access after switching", () => {
    fc.assert(fc.property(provider, effort, effort, (id, ownEffort, customEffort) => {
      let launchpad: NavigationLaunchpadDefaults = {
        backend: "codex", model: "gpt-test", reasoningEffort: ownEffort, executionMode: "full-access",
      };
      launchpad = applyNavigationLaunchpadProviderSettingsPatch(launchpad, {
        model: `@${id}/model`, reasoningEffort: customEffort, executionMode: "default",
      });
      launchpad = applyNavigationLaunchpadProviderSettingsPatch(launchpad, { model: "gpt-test" });
      expect(launchpad).toMatchObject({ model: "gpt-test", reasoningEffort: ownEffort, executionMode: "full-access" });
      launchpad = applyNavigationLaunchpadProviderSettingsPatch(launchpad, { model: `@${id}/model` });
      expect(launchpad).toMatchObject({ model: `@${id}/model`, reasoningEffort: customEffort, executionMode: "default" });
    }));
  });

  it("keeps Bonsai selected when the OpenAI default changes", () => {
    const updated = applyNavigationLaunchpadProviderModelDefaults({
      backend: "codex", model: "@bonsai/model", executionMode: "auto",
    }, { codex: { model: "gpt-next", reasoningEffortsByModel: {} } }, ["codex"]);
    expect(updated.model).toBe("@bonsai/model");
  });

  it("keeps MathOS's access when an OpenAI draft learns Auto access", () => {
    const updated = applyNavigationLaunchpadDefaultsPatch<NavigationLaunchpadDefaults>({
      backend: "codex", model: "@mathos/one", executionMode: "default",
    }, { executionMode: "auto" }, "codex");
    expect(updated.executionMode).toBe("default");
    expect(updated.providerSettings?.codex?.executionMode).toBe("auto");
  });

  it("retains provider identity when resetting a default to the advertised model", () => {
    fc.assert(fc.property(provider, (id) => {
      const launchpad = projectNavigationLaunchpadProviderSettings({
        backend: "codex", model: `@${id}/model`, executionMode: "default",
      } as NavigationLaunchpadDefaults);
      const key = providerPickerValue("codex", launchpad.model);
      const updated = applyNavigationLaunchpadProviderModelDefaults(launchpad, {}, [key]);
      expect(updated.model).toBeUndefined();
      expect(navigationLaunchpadProviderKey(updated)).toBe(key);
      expect(navigationLaunchpadProviderKey(JSON.parse(JSON.stringify(updated)))).toBe(key);
    }));
  });

  it("splits legacy reasoning memory by provider without overwriting explicit endpoint settings", () => {
    const legacy = {
      backend: "codex", model: "@mathos/one", executionMode: "default",
      providerSettings: {
        codex: {
          model: "@mathos/one", executionMode: "default",
          reasoningEffortsByModel: { "gpt-test": "high", "@mathos/one": "low" },
        },
        "codex-provider:mathos": { model: "@mathos/two", reasoningEffortsByModel: { "@mathos/two": "high" } },
      },
    } as NavigationLaunchpadDefaults;
    const normalized = projectNavigationLaunchpadProviderSettings(legacy);
    expect(normalized.model).toBe("@mathos/two");
    expect(normalized.providerSettings?.codex?.reasoningEffortsByModel).toEqual({ "gpt-test": "high" });
    expect(normalized.providerSettings?.["codex-provider:mathos"]?.reasoningEffortsByModel).toEqual({
      "@mathos/one": "low", "@mathos/two": "high",
    });
    expect(projectNavigationLaunchpadProviderSettings(normalized)).toEqual(normalized);
  });

  it("normalizes backend-wide defaults without assigning qualified models or reasoning to OpenAI", () => {
    fc.assert(fc.property(provider, effort, (id, reasoning) => {
      const key = `codex-provider:${id}`;
      const result = normalizeModelProviderDefaults({
        codex: {
          model: `@${id}/one`, reasoningEffortsByModel: { "gpt-test": "high", [`@${id}/one`]: reasoning },
          executionMode: "default",
        },
      });
      expect(result.codex).toEqual({ reasoningEffortsByModel: { "gpt-test": "high" }, executionMode: "default" });
      expect(result[key]).toEqual({ model: `@${id}/one`, reasoningEffortsByModel: { [`@${id}/one`]: reasoning }, executionMode: "default" });
      expect(normalizeModelProviderDefaults(result)).toEqual(result);
    }));
  });
});
