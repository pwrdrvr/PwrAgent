import { describe, expect, it } from "vitest";
import {
  applyNavigationLaunchpadProviderExecutionModeDefaults,
  applyNavigationLaunchpadProviderSettingsPatch,
  changedProviderExecutionModeDefaultBackends,
  forgetLegacyDefaultLaunchpadExecutionModes,
  projectNavigationLaunchpadProviderSettings,
  resolveDefaultLaunchpadExecutionMode,
  type NavigationLaunchpadDefaults,
} from "../index";

describe("launchpad access defaults", () => {
  it("starts Codex and Claude on Auto and every other provider on Default Access", () => {
    expect(resolveDefaultLaunchpadExecutionMode("codex")).toBe("auto");
    expect(resolveDefaultLaunchpadExecutionMode("claude")).toBe("auto");
    expect(resolveDefaultLaunchpadExecutionMode("acp:grok")).toBe("default");
    expect(resolveDefaultLaunchpadExecutionMode("claude", {
      claude: { executionMode: "full-access" },
    })).toBe("full-access");
    // A configured value cannot give an ACP provider an access default.
    expect(resolveDefaultLaunchpadExecutionMode("acp:grok", {
      "acp:grok": { executionMode: "full-access" },
    })).toBe("default");
  });

  it("does not carry one provider's access into another on a backend switch", () => {
    const codex = projectNavigationLaunchpadProviderSettings({
      backend: "codex",
      executionMode: "full-access",
    } as NavigationLaunchpadDefaults);
    const claude = applyNavigationLaunchpadProviderSettingsPatch(codex, { backend: "claude" });
    expect(claude.executionMode).toBe("auto");
    const grok = applyNavigationLaunchpadProviderSettingsPatch(codex, { backend: "acp:grok" });
    expect(grok.executionMode).toBe("default");
    const back = applyNavigationLaunchpadProviderSettingsPatch(claude, { backend: "codex" });
    expect(back.executionMode).toBe("full-access");
  });

  it("reports and applies only providers whose resolved access changed", () => {
    expect(changedProviderExecutionModeDefaultBackends(
      { codex: { reasoningEffortsByModel: {}, executionMode: "auto" } },
      {},
    )).toEqual([]);
    expect(changedProviderExecutionModeDefaultBackends(
      {},
      {
        claude: { reasoningEffortsByModel: {}, executionMode: "full-access" },
        "acp:grok": { reasoningEffortsByModel: {}, executionMode: "full-access" },
      },
    )).toEqual(["claude"]);

    const launchpad = projectNavigationLaunchpadProviderSettings({
      backend: "codex",
      executionMode: "default",
      model: "gpt-6-sol",
    } as NavigationLaunchpadDefaults);
    const updated = applyNavigationLaunchpadProviderExecutionModeDefaults(
      launchpad,
      { claude: { reasoningEffortsByModel: {}, executionMode: "full-access" } },
      ["claude"],
      true,
    );
    expect(updated).toMatchObject({ backend: "codex", executionMode: "default", model: "gpt-6-sol" });
    expect(updated.providerSettings?.claude).toEqual({ executionMode: "full-access" });
  });

  it("forgets only the legacy Default Access saved for Codex and Claude", () => {
    const legacy = {
      backend: "codex",
      executionMode: "default",
      providerSettings: {
        codex: { executionMode: "default", model: "gpt-6-sol" },
        claude: { executionMode: "default" },
        "acp:grok": { executionMode: "default" },
      },
    } as NavigationLaunchpadDefaults;
    const migrated = forgetLegacyDefaultLaunchpadExecutionModes(legacy);
    expect(migrated.executionMode).toBe("auto");
    expect(migrated.providerSettings).toEqual({
      codex: { model: "gpt-6-sol" },
      "acp:grok": { executionMode: "default" },
    });

    const chosen = {
      backend: "claude",
      executionMode: "full-access",
      providerSettings: { claude: { executionMode: "full-access" } },
    } as NavigationLaunchpadDefaults;
    expect(forgetLegacyDefaultLaunchpadExecutionModes(chosen)).toBe(chosen);
  });
});
