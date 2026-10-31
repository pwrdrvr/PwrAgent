import { describe, expect, it } from "vitest";
import { DEFAULT_FORGE_AGENT_TOOL_POLICY } from "@pwragent/shared";
import { desktopSettingsPatchToEdits, parseDesktopSettingsToml } from "../settings/desktop-config";
import { applyTomlEdits, parseTomlTables } from "../settings/toml-editor";

describe("CI rerun policy config", () => {
  it("defaults to Auto for existing configs without rewriting them", () => {
    const parsed = parseDesktopSettingsToml("[git.agent_tools]\nread = \"allow\"\n", "test.toml");
    expect(parsed.git?.agentTools?.access?.ci).toBeUndefined();
    expect(DEFAULT_FORGE_AGENT_TOOL_POLICY.access.ci).toBe("auto");
  });

  it.each(["allow", "auto", "ask", "off"] as const)("round trips %s without changing other policies or comments", (ci) => {
    const existing = "# Operator policy\n[git.agent_tools]\nread = \"off\"\ncomments = \"ask\"\n";
    const written = applyTomlEdits(existing, desktopSettingsPatchToEdits(
      { git: { agentTools: { access: { ci } } } },
      parseTomlTables(existing, "test.toml"),
    ));
    expect(written).toContain("# Operator policy");
    expect(parseDesktopSettingsToml(written, "test.toml").git?.agentTools?.access).toEqual({ read: "off", comments: "ask", ci });
  });
});
