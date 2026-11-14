import fc from "fast-check";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  codexModelProviderApiKeyEnv,
  type CodexModelProviderSettings,
} from "@pwragent/shared";
import {
  applyManagedProviderBlock,
  isPwrAgentManagedCodexHome,
  syncCodexProfileProviderConfig,
} from "../settings/codex-profile-provider-config";
import { isCodexTomlTable, parseCodexConfigToml } from "../settings/codex-config-toml";

/**
 * The rule: in a Codex home PwrAgent manages, its `config.toml` defines every
 * registered model provider so the Codex CLI on that home can use it. PwrAgent
 * owns one marked block and nothing else:
 *
 * - every byte outside the block is the operator's and survives each write;
 * - a provider the operator defined there themselves is never redefined;
 * - the block holds exactly the other providers, with the fields Codex reads;
 * - writing is idempotent, and with no providers the file is as it was;
 * - no key value is ever written, only the environment variable's name.
 */
const PROVIDER_IDS = ["mathos", "refuseless", "local-llm", "openrouter"];

const providerArbitrary = fc.record({
  id: fc.constantFrom(...PROVIDER_IDS),
  name: fc.constantFrom("MathOS", "Refuseless", "Local \"LLM\"", "Open Router\\Lab"),
  baseUrl: fc.constantFrom("https://mathos.example/v1", "http://127.0.0.1:8080/v1", "https://api.refuseless.example/v1"),
  bonsai: fc.boolean(),
  hasKey: fc.boolean(),
});

/** Operator content: comments, top-level keys, tables, maybe their own provider. */
const operatorContent = fc.record({
  header: fc.constantFrom("", "# my Codex config\n", "model = \"gpt-6-sol\"\napproval_policy = \"on-request\"\n"),
  ownProvider: fc.option(fc.constantFrom(...PROVIDER_IDS), { nil: undefined }),
  tail: fc.constantFrom("", "\n[mcp_servers.docs]\ncommand = \"docs-mcp\"\nargs = [\"--stdio\"]\n", "\n[projects.\"/tmp/x\"]\ntrust_level = \"trusted\"\n"),
}).map(({ header, ownProvider, tail }) => ({
  ownProvider,
  text: `${header}${ownProvider ? `\n[model_providers.${ownProvider}]\nname = "Mine"\nbase_url = "https://mine.example/v1"\n` : ""}${tail}`,
}));

function settings(entries: Array<{ id: string; name: string; baseUrl: string; bonsai: boolean }>): CodexModelProviderSettings[] {
  const seen = new Set<string>();
  return entries.filter((entry) => !seen.has(entry.id) && seen.add(entry.id)).map((entry) => ({
    id: entry.id,
    name: entry.name,
    baseUrl: entry.baseUrl,
    ...(entry.bonsai ? { compatibility: "bonsai" as const, models: ["bonsai-8b.gguf"] } : {}),
  }));
}

/** The text with PwrAgent's block, and the blank line it adds before it, taken out. */
function outsideBlock(text: string): string {
  return text
    .replace(/(\n)\n# >>> PwrAgent model providers[\s\S]*?# <<< PwrAgent model providers\n/u, "$1")
    .replace(/^# >>> PwrAgent model providers[\s\S]*?# <<< PwrAgent model providers\n/u, "");
}

describe("PwrAgent's provider block in a managed Codex config.toml", () => {
  it("owns only its block, skips the operator's providers, and defines the rest as Codex reads them", () => {
    fc.assert(fc.property(operatorContent, fc.array(providerArbitrary, { maxLength: 4 }), ({ ownProvider, text }, specs) => {
      const providers = settings(specs);
      const withKeys = new Set(specs.filter((spec) => spec.hasKey).map((spec) => spec.id));
      const first = applyManagedProviderBlock(text, providers, withKeys);
      // Idempotent, and the operator's text survives byte for byte.
      expect(applyManagedProviderBlock(first.text, providers, withKeys).text).toBe(first.text);
      expect(outsideBlock(first.text)).toBe(text);
      // With no providers the file is exactly what the operator wrote.
      expect(applyManagedProviderBlock(first.text, [], withKeys).text).toBe(text);

      const expected = providers.filter((provider) => !provider.compatibility && provider.id !== ownProvider);
      expect(first.written).toEqual(expected.map((provider) => provider.id));
      const parsed = parseCodexConfigToml(first.text);
      const tables = parsed.model_providers;
      for (const provider of expected) {
        const table = isCodexTomlTable(tables) ? tables[provider.id] : undefined;
        expect(table).toMatchObject({
          name: provider.name,
          base_url: provider.baseUrl,
          wire_api: "responses",
          requires_openai_auth: false,
        });
        const envKey = isCodexTomlTable(table) ? table.env_key : undefined;
        expect(envKey).toBe(withKeys.has(provider.id) ? codexModelProviderApiKeyEnv(provider.id) : undefined);
      }
      if (ownProvider && isCodexTomlTable(tables)) {
        expect(tables[ownProvider]).toMatchObject({ name: "Mine" });
      }
    }), { numRuns: 300 });
  });

  it("writes nothing into a file it cannot read as TOML", () => {
    const broken = "[model_providers.mathos\nname = ";
    const result = applyManagedProviderBlock(broken, settings([{ id: "mathos", name: "MathOS", baseUrl: "https://mathos.example/v1", bonsai: false }]), new Set());
    expect(result.text).toBe(broken);
    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual([{ id: "mathos", reason: expect.stringContaining("could not be read") }]);
  });
});

describe("syncCodexProfileProviderConfig", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("creates, updates and removes the block in a managed home, and never touches an unmanaged one", async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "pwragent-codex-profiles-"));
    const profileRoot = path.join(root, "profiles");
    const home = path.join(profileRoot, "pwragent");
    const mathos = settings([{ id: "mathos", name: "MathOS", baseUrl: "https://mathos.example/v1", bonsai: false }]);

    expect(isPwrAgentManagedCodexHome(home, profileRoot)).toBe(true);
    expect(isPwrAgentManagedCodexHome(path.join(root, ".codex"), profileRoot)).toBe(false);
    expect(isPwrAgentManagedCodexHome(profileRoot, profileRoot)).toBe(false);

    const created = await syncCodexProfileProviderConfig({ codexHome: home, profileRoot, providers: mathos, providerIdsWithKeys: new Set(["mathos"]) });
    expect(created).toMatchObject({ changed: true, written: ["mathos"] });
    const configPath = path.join(home, "config.toml");
    expect(readFileSync(configPath, "utf8")).toContain("[model_providers.mathos]");
    expect(statSync(configPath).mode & 0o777).toBe(0o600);

    writeFileSync(configPath, `model = "gpt-6-sol"\n${readFileSync(configPath, "utf8")}`);
    chmodSync(configPath, 0o644);
    expect(await syncCodexProfileProviderConfig({ codexHome: home, profileRoot, providers: mathos, providerIdsWithKeys: new Set(["mathos"]) }))
      .toMatchObject({ changed: false });
    await syncCodexProfileProviderConfig({ codexHome: home, profileRoot, providers: [], providerIdsWithKeys: new Set() });
    expect(readFileSync(configPath, "utf8")).toBe("model = \"gpt-6-sol\"\n");
    expect(statSync(configPath).mode & 0o777).toBe(0o644);

    const shared = path.join(root, ".codex");
    expect(await syncCodexProfileProviderConfig({ codexHome: shared, profileRoot, providers: mathos, providerIdsWithKeys: new Set() }))
      .toMatchObject({ changed: false, managed: false });
    expect(existsSync(path.join(shared, "config.toml"))).toBe(false);
  });
});
