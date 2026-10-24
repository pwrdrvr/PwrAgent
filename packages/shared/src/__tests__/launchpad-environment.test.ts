import { describe, expect, it } from "vitest";
import {
  applyNavigationLaunchpadProviderSettingsPatch,
  projectNavigationLaunchpadProviderSettings,
  type NavigationLaunchpadDraft,
} from "../index";

function draft(): NavigationLaunchpadDraft {
  return {
    directoryKey: "directory:/repo",
    directoryKind: "directory",
    directoryLabel: "Repo",
    directoryPath: "/repo",
    backend: "codex",
    executionMode: "auto",
    workMode: "local",
    prompt: "draft",
    codexEnvironmentId: "project",
    codexEnvironmentExecutionTarget: "local",
    codexEnvironmentActionId: "dev",
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("launchpad environment memory", () => {
  it("shares the current environment across OpenAI, Claude and ACP switches", () => {
    let value = draft();
    for (const backend of ["claude", "acp:grok", "codex"] as const) {
      value = applyNavigationLaunchpadProviderSettingsPatch(value, { backend });
      expect(value).toMatchObject({
        backend,
        codexEnvironmentId: "project",
        codexEnvironmentExecutionTarget: "local",
        codexEnvironmentActionId: "dev",
      });
    }
    value = applyNavigationLaunchpadProviderSettingsPatch(value, {
      codexEnvironmentId: "other",
      codexEnvironmentActionId: undefined,
    });
    expect(applyNavigationLaunchpadProviderSettingsPatch(value, { backend: "claude" }))
      .toMatchObject({ codexEnvironmentId: "other", codexEnvironmentActionId: undefined });
  });

  it("migrates the active provider's legacy selection without reviving inactive choices", () => {
    const legacy = draft();
    delete legacy.codexEnvironmentId;
    delete legacy.codexEnvironmentExecutionTarget;
    delete legacy.codexEnvironmentActionId;
    legacy.providerSettings = {
      codex: { model: "gpt", codexEnvironmentId: "project", codexEnvironmentActionId: "dev" },
      claude: { model: "sonnet", codexEnvironmentId: "stale" },
    };
    const migrated = projectNavigationLaunchpadProviderSettings(legacy);
    expect(migrated.codexEnvironmentId).toBe("project");
    expect(migrated.providerSettings).toEqual({ codex: { model: "gpt" }, claude: { model: "sonnet" } });
    const cleared = applyNavigationLaunchpadProviderSettingsPatch(migrated, {
      codexEnvironmentId: undefined,
      codexEnvironmentExecutionTarget: undefined,
      codexEnvironmentActionId: undefined,
    });
    const reopened = JSON.parse(JSON.stringify(cleared)) as NavigationLaunchpadDraft;
    expect(applyNavigationLaunchpadProviderSettingsPatch(reopened, { backend: "claude" }).codexEnvironmentId)
      .toBeUndefined();
    expect(projectNavigationLaunchpadProviderSettings(reopened).codexEnvironmentId).toBeUndefined();
  });

  it("prefers the top-level selection over stale provider memory", () => {
    const value = draft();
    value.providerSettings = { codex: { codexEnvironmentId: "stale" } };
    expect(projectNavigationLaunchpadProviderSettings(value).codexEnvironmentId).toBe("project");
  });
});
