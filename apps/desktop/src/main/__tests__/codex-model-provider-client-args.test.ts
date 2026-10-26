import { describe, expect, it } from "vitest";
import type { CodexModelProviderSettings } from "@pwragent/shared";
import { buildCodexClientArgs } from "../app-server/backend-registry";

const refuseless: CodexModelProviderSettings = {
  id: "refuseless",
  name: "Refuseless",
  baseUrl: "https://api.refuseless.example/v1",
};
const bonsai: CodexModelProviderSettings = {
  id: "bonsai",
  name: "Bonsai",
  baseUrl: "http://127.0.0.1:8080/v1",
  local: true,
};

describe("buildCodexClientArgs with model providers", () => {
  it("defines providers, keeps keys out of arguments and blanks them for model commands last", () => {
    const args = buildCodexClientArgs(
      { PWRAGENT_CODEX_PROVIDER_REFUSELESS_API_KEY: "sk-secret", PATH: "/usr/bin" },
      ["shell_environment_policy.set.PWRAGENT_CODEX_PROVIDER_REFUSELESS_API_KEY=\"leak\""],
      [refuseless, bonsai],
    );
    const overrides = args.filter((_arg, index) => args[index - 1] === "-c");
    expect(args.join(" ")).not.toContain("sk-secret");
    expect(overrides).toContain("model_providers.refuseless.env_key=\"PWRAGENT_CODEX_PROVIDER_REFUSELESS_API_KEY\"");
    // A provider without a stored key names no env_key, or Codex would fail its requests.
    expect(overrides.some((entry) => entry.startsWith("model_providers.bonsai.env_key"))).toBe(false);
    expect(overrides.at(-1)).toBe("shell_environment_policy.set.PWRAGENT_CODEX_PROVIDER_REFUSELESS_API_KEY=\"\"");
    expect(overrides.indexOf("model_providers.refuseless.name=\"Refuseless\""))
      .toBeLessThan(overrides.indexOf("approval_policy=\"on-request\""));
  });

  it("adds nothing without providers", () => {
    expect(buildCodexClientArgs({}, [], []).join(" ")).not.toContain("model_providers");
  });
});
