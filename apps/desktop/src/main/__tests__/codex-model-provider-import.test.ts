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

const source = { label: "bonsai", configPath: "/home/me/.codex/profiles/bonsai/config.toml" };

function importsFrom(toml: string) {
  return codexModelProviderImportsFromConfig(parseCodexConfigToml(toml), source);
}

describe("codexModelProviderImportsFromConfig", () => {
  it("prefills a local Bonsai profile from its model and provider", () => {
    expect(importsFrom([
      "model = \"/models/Ternary-Bonsai-2-27B.gguf\"",
      "model_provider = \"bonsai\"",
      "model_catalog_json = \"/home/me/.codex/profiles/bonsai/models.json\"",
      "[model_providers.bonsai]",
      "name = \"PrismML Bonsai (local)\"",
      "base_url = \"http://127.0.0.1:18080/v1/\"",
      "wire_api = \"responses\"",
      "requires_openai_auth = false",
    ].join("\n"))).toEqual([{
      sourceId: "bonsai",
      name: "PrismML Bonsai (local)",
      baseUrl: "http://127.0.0.1:18080/v1",
      models: ["/models/Ternary-Bonsai-2-27B.gguf"],
      local: true,
      needsApiKey: false,
      notes: [],
      sources: [source],
    }]);
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
    const bonsai = "[model_providers.bonsai]\nbase_url = \"http://127.0.0.1:18080/v1\"\n";
    const main = await home("main", bonsai);
    const profile = await home("profile", `model = "bonsai-27b"\nmodel_provider = "bonsai"\n${bonsai}`);
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
      sourceId: "bonsai",
      models: ["bonsai-27b"],
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
