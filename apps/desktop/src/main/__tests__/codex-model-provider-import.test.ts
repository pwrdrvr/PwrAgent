import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DesktopCodexAuthProfileDiscoverySnapshot } from "@pwragent/shared";
import {
  codexConfigHomesFromProfiles,
  codexModelProviderImportsFromConfig,
  scanCodexModelProviderImports,
} from "../settings/codex-model-provider-import";
import { parseCodexConfigToml } from "../settings/codex-config-toml";
import { readBonsaiCatalog } from "../codex-app-server/bonsai-runtime";

const source = { label: "bonsai", configPath: "/home/me/.codex/profiles/bonsai/config.toml" };

function importsFrom(toml: string) {
  return codexModelProviderImportsFromConfig(parseCodexConfigToml(toml), source);
}

describe("codexModelProviderImportsFromConfig", () => {
  it("imports a supported Bonsai profile with isolated compatibility and its catalog", () => {
    expect(importsFrom([
      "model = \"/models/Ternary-Bonsai-2-27B.gguf\"",
      "model_provider = \"bonsai\"",
      "model_catalog_json = \"/home/me/.codex/profiles/bonsai/models.json\"",
      "model_context_window = 65536",
      "model_auto_compact_token_limit = 49152",
      "web_search = \"disabled\"",
      "[features]",
      "multi_agent = false",
      "goals = false",
      "apps = false",
      "plugins = false",
      "image_generation = false",
      "[model_providers.bonsai]",
      "name = \"PrismML Bonsai (local)\"",
      "base_url = \"http://127.0.0.1:18080/v1/\"",
      "wire_api = \"responses\"",
      "requires_openai_auth = false",
    ].join("\n"))).toEqual([expect.objectContaining({
      sourceId: "bonsai",
      name: "PrismML Bonsai (local)",
      baseUrl: "http://127.0.0.1:18080/v1",
      models: ["/models/Ternary-Bonsai-2-27B.gguf"],
      compatibility: "bonsai",
      catalogPath: path.resolve("/home/me/.codex/profiles/bonsai/models.json"),
      notes: [expect.stringContaining("isolated Codex runtime")],
      sources: [source],
    })]);
  });

  it("blocks Bonsai settings the compatibility runtime cannot preserve", () => {
    const [entry] = importsFrom([
      "model_provider = \"bonsai\"",
      "model = \"/models/Bonsai.gguf\"",
      "model_catalog_json = \"/secret/catalog.json\"",
      "model_context_window = 131072",
      "model_auto_compact_token_limit = 49152",
      "[features]",
      "plugins = false",
      "[model_providers.bonsai]",
      "base_url = \"http://127.0.0.1:18080/v1\"",
    ].join("\n"));
    expect("reason" in entry && entry.reason).toMatch(/model_catalog_json, model_context_window, model_auto_compact_token_limit, features.plugins/u);
    expect(JSON.stringify(entry)).not.toContain("/secret/catalog.json");
  });

  it("blocks an incomplete Bonsai definition without a model", () => {
    const [entry] = importsFrom("[model_providers.bonsai]\nbase_url = \"http://localhost:18080/v1\"\n");
    expect(entry).toMatchObject({ reason: expect.stringContaining("exactly one model") });
  });

  it("recognizes Bonsai's model when the provider is renamed", () => {
    const [entry] = importsFrom([
      "[model_providers.gpu]",
      "base_url = \"http://127.0.0.1:8080/v1\"",
      "[profiles.local]",
      "model_provider = \"gpu\"",
      "model = \"/models/Ternary-Bonsai-2-27B.gguf\"",
    ].join("\n"));
    expect(entry).toMatchObject({ sourceId: "gpu", compatibility: "bonsai", notes: [expect.stringContaining("compatibility bridge")] });
  });

  it("retains a named profile's catalog and blocks conflicting catalogs for one provider", () => {
    const config = [
      'model_provider = "bonsai"', 'model = "Bonsai.gguf"', '[model_providers.bonsai]',
      'base_url = "http://localhost:8080/v1"', '[profiles.local]', 'model_catalog_json = "models.json"',
    ];
    expect(importsFrom(config.join("\n"))[0]).toMatchObject({
      compatibility: "bonsai", catalogPath: path.resolve("/home/me/.codex/profiles/bonsai/models.json"),
    });
    expect(importsFrom([...config, '[profiles.other]', 'model_catalog_json = "other.json"'].join("\n"))[0]).toMatchObject({
      reason: expect.stringContaining("different model catalogs"),
    });
  });

  it("does not assume every local GGUF endpoint needs Bonsai's compatibility settings", () => {
    const [entry] = importsFrom([
      "model_provider = \"gpu\"",
      "model = \"/models/other.gguf\"",
      "[model_providers.gpu]",
      "base_url = \"http://localhost:8080/v1\"",
    ].join("\n"));
    expect(entry).toMatchObject({ sourceId: "gpu", models: ["/models/other.gguf"] });
    expect(entry).not.toHaveProperty("reason");
  });

  it("keeps regular OpenAI imports separate from another provider's compatibility settings", () => {
    const entries = importsFrom([
      "model_provider = \"hosted\"",
      "model = \"gpt-5.5\"",
      "[model_providers.hosted]",
      "base_url = \"https://api.openai.com/v1\"",
      "env_key = \"OPENAI_API_KEY\"",
      "[model_providers.local]",
      "base_url = \"http://localhost:18080/v1\"",
      "[profiles.local]",
      "model_provider = \"local\"",
      "model_catalog_json = \"models.json\"",
      "model_context_window = 65536",
      "model_auto_compact_token_limit = 49152",
      "[profiles.local.features]",
      "plugins = false",
    ].join("\n"));
    expect(entries[0]).toMatchObject({ sourceId: "hosted", models: ["gpt-5.5"], needsApiKey: true, notes: [] });
    expect(entries[0]).not.toHaveProperty("reason");
    expect(entries[1]).toMatchObject({ sourceId: "local", reason: expect.stringContaining("model_catalog_json") });
  });

  it("checks compatibility settings inherited by a named profile", () => {
    const [entry] = importsFrom([
      "model_catalog_json = \"models.json\"",
      "[model_providers.gpu]",
      "base_url = \"http://gpu.lan:8000/v1\"",
      "[profiles.local]",
      "model_provider = \"gpu\"",
      "model = \"local-model\"",
    ].join("\n"));
    expect(entry).toMatchObject({ reason: expect.stringContaining("model_catalog_json") });
  });

  it("asks for a key by its variable name and never copies key material", () => {
    const [candidate] = importsFrom([
      "[model_providers.hosted]",
      "base_url = \"https://api.hosted.example/v1\"",
      "env_key = \"HOSTED_API_KEY\"",
      "experimental_bearer_token = \"sk-secret-token\"",
      "http_headers = { \"X-Api-Key\" = \"sk-header-secret\" }",
      "[profiles.fast]",
      "model_provider = \"hosted\"",
      "model = \"glm-5.3-flash\"",
      "[profiles.other]",
      "model = \"gpt-5.5\"",
    ].join("\n"));
    expect(candidate).toMatchObject({
      sourceId: "hosted",
      name: "hosted",
      models: ["glm-5.3-flash"],
      local: false,
      needsApiKey: true,
      apiKeyEnv: "HOSTED_API_KEY",
    });
    expect(JSON.stringify(candidate)).not.toMatch(/sk-secret-token|sk-header-secret/u);
    expect("notes" in candidate && candidate.notes).toEqual([
      "The file's bearer token is not copied.",
      "Its HTTP headers are not imported.",
    ]);
  });

  it("says why each provider it cannot import was skipped", () => {
    const entries = importsFrom([
      "[model_providers.legacy]",
      "name = \"Legacy chat\"",
      "base_url = \"http://localhost:1234/v1\"",
      "wire_api = \"chat\"",
      "[model_providers.nourl]",
      "env_key = \"X\"",
      "[model_providers.azure_like]",
      "base_url = \"https://x.openai.azure.com/openai\"",
      "query_params = { api-version = \"2025-04-01-preview\" }",
      "[model_providers.bedrock_like]",
      "base_url = \"https://bedrock.example/v1\"",
      "aws = { region = \"us-east-1\" }",
      "[model_providers.inurl]",
      "base_url = \"https://user:pass@api.example/v1\"",
      "[model_providers.badurl]",
      "base_url = \"ftp://files.example/v1\"",
    ].join("\n"));
    expect(entries.map((entry) => "reason" in entry ? [entry.sourceId, entry.reason] : entry)).toEqual([
      ["legacy", "It uses wire_api = \"chat\". Codex 0.164 and later speak only the Responses API."],
      ["nourl", "It has no base_url."],
      ["azure_like", "It sends query_params, which a PwrAgent provider cannot send."],
      ["bedrock_like", "It signs requests with AWS credentials, which a PwrAgent provider cannot do."],
      ["inurl", "Its base_url holds credentials, which are not copied."],
      ["badurl", "Its base_url cannot be used. The base URL must use http or https."],
    ]);
  });

  it("asks for a key when env_key is not a plain variable name", () => {
    const [candidate] = importsFrom([
      "[model_providers.odd]",
      "base_url = \"https://odd.example/v1\"",
      "env_key = \"odd-api-key\"",
    ].join("\n"));
    expect(candidate).toMatchObject({ sourceId: "odd", needsApiKey: true });
    expect(candidate).not.toHaveProperty("apiKeyEnv");
  });

  it("treats an absent wire_api as responses", () => {
    const [candidate] = importsFrom("[model_providers.gpu]\nbase_url = \"http://gpu.lan:8000/v1\"\n");
    expect(candidate).toMatchObject({ sourceId: "gpu", local: false, needsApiKey: false });
  });

  it("finds nothing in a config without providers", () => {
    expect(importsFrom("model = \"gpt-5.5\"\n")).toEqual([]);
  });
});

describe("scanCodexModelProviderImports", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "codex-provider-import-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function home(name: string, toml?: string): Promise<string> {
    const dir = path.join(root, name);
    await mkdir(dir, { recursive: true });
    if (toml !== undefined) await writeFile(path.join(dir, "config.toml"), toml);
    return dir;
  }

  it("merges one endpoint found in two homes and reports unreadable files", async () => {
    const provider = "[model_providers.local]\nbase_url = \"http://127.0.0.1:18080/v1\"\n";
    const main = await home("main", provider);
    const profile = await home("profile", `model = "local-model"\nmodel_provider = "local"\n${provider}`);
    const broken = await home("broken", "[model_providers.x\n");
    const empty = await home("empty");
    const scan = await scanCodexModelProviderImports([
      { codexHome: main, label: "Codex home" },
      { codexHome: profile, label: "bonsai" },
      { codexHome: broken, label: "broken" },
      { codexHome: empty, label: "empty" },
    ]);
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0]).toMatchObject({
      sourceId: "local",
      models: ["local-model"],
      local: true,
      sources: [
        { label: "Codex home", configPath: path.join(main, "config.toml") },
        { label: "bonsai", configPath: path.join(profile, "config.toml") },
      ],
    });
    expect(scan.skipped).toEqual([{
      reason: "Its config.toml could not be parsed: Expected the end of a table header on line 1.",
      sources: [{ label: "broken", configPath: path.join(broken, "config.toml") }],
    }]);
  });

  it.each([false, true])("blocks an endpoint alias when another home declares compatibility requirements (reverse=%s)", async (reverse) => {
    const plain = await home("plain", "[model_providers.alias]\nbase_url = \"http://127.0.0.1:18080/v1/\"\n");
    const restricted = await home("restricted", [
      "model_provider = \"local\"",
      "model_catalog_json = \"models.json\"",
      "[model_providers.local]",
      "base_url = \"http://127.0.0.1:18080/v1\"",
    ].join("\n"));
    const homes = [plain, restricted].map((codexHome) => ({ codexHome, label: codexHome }));
    const scan = await scanCodexModelProviderImports(reverse ? homes.reverse() : homes);
    expect(scan.candidates).toEqual([]);
    expect(scan.skipped).toEqual([expect.objectContaining({
      sourceId: "local",
      baseUrl: "http://127.0.0.1:18080/v1",
      reason: expect.stringContaining("model_catalog_json"),
    })]);
  });

  it("checks the imported catalog before offering Bonsai and reports missing catalogs as blocked imports", async () => {
    const dir = await home("bonsai", [
      'model_provider = "bonsai"', 'model = "/models/Bonsai.gguf"', 'model_catalog_json = "models.json"',
      '[model_providers.bonsai]', 'base_url = "http://127.0.0.1:18080/v1"',
    ].join("\n"));
    const homes = [{ codexHome: dir, label: "Bonsai" }];
    expect((await scanCodexModelProviderImports(homes)).skipped).toEqual([expect.objectContaining({
      reason: expect.stringContaining("Bonsai catalog cannot be imported"),
    })]);
    const template = await readBonsaiCatalog({
      id: "bonsai", name: "Bonsai", baseUrl: "http://127.0.0.1:18080/v1", models: ["/models/Bonsai.gguf"], compatibility: "bonsai",
    });
    await writeFile(path.join(dir, "models.json"), JSON.stringify(template));
    expect((await scanCodexModelProviderImports(homes)).candidates).toEqual([expect.objectContaining({
      compatibility: "bonsai", catalogPath: path.join(dir, "models.json"),
    })]);
  });

  it.each(["model", "catalog", "compatibility"])("blocks conflicting Bonsai %s definitions across homes in either scan order", async (conflict) => {
    const config = (model: string, catalog?: string, id = "bonsai") => [
      `model_provider = "${id}"`, `model = "${model}"`,
      ...(catalog ? [`model_catalog_json = ${JSON.stringify(catalog)}`] : []),
      `[model_providers.${id}]`, 'base_url = "http://127.0.0.1:18080/v1"',
    ].join("\n");
    const first = await home("first", config("Bonsai.gguf", conflict === "catalog" ? "models.json" : undefined));
    const second = await home("second", config(
      conflict === "model" ? "Other-Bonsai.gguf" : conflict === "compatibility" ? "other-model" : "Bonsai.gguf",
      conflict === "catalog" ? "models.json" : undefined,
      conflict === "compatibility" ? "alias" : "bonsai",
    ));
    if (conflict === "catalog") {
      const catalog = await readBonsaiCatalog({
        id: "bonsai", name: "Bonsai", baseUrl: "http://127.0.0.1:18080/v1", models: ["Bonsai.gguf"], compatibility: "bonsai",
      });
      await writeFile(path.join(first, "models.json"), JSON.stringify(catalog));
      catalog.models[0].base_instructions = "Different instructions";
      await writeFile(path.join(second, "models.json"), JSON.stringify(catalog));
    }
    const homes = [first, second].map((codexHome) => ({ codexHome, label: codexHome }));
    for (const ordered of [homes, [...homes].reverse()]) {
      const scan = await scanCodexModelProviderImports(ordered);
      expect(scan.candidates).toEqual([]);
      expect(scan.skipped).toEqual([expect.objectContaining({
        baseUrl: "http://127.0.0.1:18080/v1",
        reason: expect.stringContaining("conflicting Bonsai"),
        sources: ordered.map((item) => ({ label: item.label, configPath: path.join(item.codexHome, "config.toml") })),
      })]);
    }
  });

  it("merges matching Bonsai definitions without losing catalog instructions", async () => {
    const catalogPath = path.join(root, "models.json");
    const catalog = await readBonsaiCatalog({
      id: "bonsai", name: "Bonsai", baseUrl: "http://127.0.0.1:18080/v1", models: ["Bonsai.gguf"], compatibility: "bonsai",
    });
    await writeFile(catalogPath, JSON.stringify(catalog));
    const toml = [
      'model_provider = "bonsai"', 'model = "Bonsai.gguf"',
      `model_catalog_json = ${JSON.stringify(catalogPath)}`,
      '[model_providers.bonsai]', 'base_url = "http://127.0.0.1:18080/v1"',
    ].join("\n");
    const homes = await Promise.all([home("first", toml), home("second", toml)]);
    const scan = await scanCodexModelProviderImports(homes.map((codexHome) => ({ codexHome, label: codexHome })));
    expect(scan.skipped).toEqual([]);
    expect(scan.candidates).toEqual([expect.objectContaining({ models: ["Bonsai.gguf"], catalogPath, sources: expect.any(Array) })]);
    expect(scan.candidates[0].sources).toHaveLength(2);
  });

  it("reports each conflicting endpoint separately when homes reuse the provider name", async () => {
    const homes = [];
    for (const port of [18080, 18081]) {
      for (const model of ["Bonsai.gguf", "Other-Bonsai.gguf"]) {
        const codexHome = await home(`${port}-${model}`, [
          'model_provider = "bonsai"', `model = "${model}"`,
          '[model_providers.bonsai]', `base_url = "http://127.0.0.1:${port}/v1"`,
        ].join("\n"));
        homes.push({ codexHome, label: codexHome });
      }
    }
    const scan = await scanCodexModelProviderImports(homes);
    expect(scan.candidates).toEqual([]);
    expect(scan.skipped.map((entry) => entry.baseUrl)).toEqual(["http://127.0.0.1:18080/v1", "http://127.0.0.1:18081/v1"]);
    expect(scan.skipped.map((entry) => entry.sources.length)).toEqual([2, 2]);
  });

  it("does not read a config.toml larger than 1 MiB", async () => {
    const big = await home("big", `# ${"x".repeat(1024 * 1024)}\n`);
    const scan = await scanCodexModelProviderImports([{ codexHome: big, label: "big" }]);
    expect(scan).toEqual({
      candidates: [],
      skipped: [{
        reason: "Its config.toml is larger than 1 MiB, so it was not read.",
        sources: [{ label: "big", configPath: path.join(big, "config.toml") }],
      }],
    });
  });
});

describe("codexConfigHomesFromProfiles", () => {
  it("reads one directory once however its path is spelled", () => {
    const snapshot: DesktopCodexAuthProfileDiscoverySnapshot = {
      profileRoot: "/home/me/.codex/profiles",
      effectiveCodexHome: "/home/me/.codex",
      profiles: [{
        name: "default",
        displayName: "Default",
        codexHome: "/home/me/.codex/",
        source: "default",
        exists: true,
        selected: true,
        hasAuthFile: true,
        hasConfigFile: true,
      }],
    };
    expect(codexConfigHomesFromProfiles(snapshot)).toEqual([{ codexHome: "/home/me/.codex", label: "Default" }]);
  });

  it("lists the active home first and each existing profile once", () => {
    const snapshot: DesktopCodexAuthProfileDiscoverySnapshot = {
      profileRoot: "/home/me/.codex/profiles",
      effectiveCodexHome: "/home/me/.codex",
      profiles: [
        {
          name: "default",
          displayName: "Default",
          codexHome: "/home/me/.codex",
          source: "default",
          exists: true,
          selected: true,
          hasAuthFile: true,
          hasConfigFile: true,
        },
        {
          name: "bonsai",
          displayName: "bonsai",
          codexHome: "/home/me/.codex/profiles/bonsai",
          source: "directory",
          exists: true,
          selected: false,
          hasAuthFile: false,
          hasConfigFile: true,
        },
        {
          name: "planned",
          displayName: "planned",
          codexHome: "/home/me/.codex/profiles/planned",
          source: "config",
          exists: false,
          selected: false,
          hasAuthFile: false,
          hasConfigFile: false,
        },
      ],
    };
    expect(codexConfigHomesFromProfiles(snapshot)).toEqual([
      { codexHome: "/home/me/.codex", label: "Default" },
      { codexHome: "/home/me/.codex/profiles/bonsai", label: "bonsai" },
    ]);
  });
});
