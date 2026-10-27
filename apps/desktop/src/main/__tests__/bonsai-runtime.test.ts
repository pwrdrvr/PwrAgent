import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexModelProviderSettings } from "@pwragent/shared";
import { bonsaiNativeMcpOverrides, prepareBonsaiRuntime, readBonsaiCatalog } from "../codex-app-server/bonsai-runtime";

const bridge = vi.hoisted(() => ({
  discover: vi.fn(async (_upstream: string, template: unknown) => template),
  close: vi.fn((callback: (error?: Error) => void) => callback()),
  closeAllConnections: vi.fn(),
}));
vi.mock("../codex-app-server/local-responses-bridge.mjs", () => ({
  discoverModelCatalog: bridge.discover,
  startBridge: vi.fn(async () => ({ address: () => ({ port: 12345 }), close: bridge.close, closeAllConnections: bridge.closeAllConnections })),
}));
const provider: CodexModelProviderSettings = {
  id: "bonsai", name: "Bonsai", baseUrl: "http://127.0.0.1:18080/v1", models: ["/models/Bonsai.gguf"], compatibility: "bonsai",
};
const directories: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("isolated Bonsai launch resources", () => {
  it("disables native MCPs in one table override, including names the CLI dotted-key parser would misparse", () => {
    expect(bonsaiNativeMcpOverrides(["awsdocs", "computer-use", "server.with.dots"])).toEqual([
      'mcp_servers={"awsdocs"={enabled=false},"computer-use"={enabled=false},"server.with.dots"={enabled=false}}',
    ]);
    expect(bonsaiNativeMcpOverrides([])).toEqual([]);
  });
  it("generates a private catalog with model capabilities and process-local compatibility overrides", async () => {
    const runtime = await prepareBonsaiRuntime(provider);
    try {
      const catalogArg = runtime.overrides.find((value) => value.startsWith("model_catalog_json="))!;
      const catalogPath = JSON.parse(catalogArg.slice("model_catalog_json=".length)) as string;
      const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
      expect(catalog.models[0]).toMatchObject({
        slug: "/models/Bonsai.gguf", context_window: 65536, apply_patch_tool_type: null,
        supported_reasoning_levels: [], input_modalities: ["text"], supports_search_tool: false,
      });
      expect((await stat(catalogPath)).mode & 0o777).toBe(0o600);
      expect(runtime.overrides).toEqual(expect.arrayContaining([
        'model_provider="bonsai"', 'model_providers.bonsai.base_url="http://127.0.0.1:12345/v1"',
        "model_context_window=65536", "model_auto_compact_token_limit=49152", "features.apps=false", "features.plugins=false",
        "features.goals=false", "features.multi_agent=false", "features.image_generation=false", 'web_search="disabled"',
      ]));
      expect(bridge.discover).toHaveBeenCalledWith(provider.baseUrl, expect.any(Object));
      await runtime.close();
      await expect(stat(catalogPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(bridge.close).toHaveBeenCalledOnce();
    } finally { await runtime.close(); }
  });

  it("preserves the imported catalog's instructions and rejects a mismatched model or capabilities", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "bonsai-catalog-"));
    directories.push(directory);
    const catalogPath = path.join(directory, "models.json");
    const template = await readBonsaiCatalog(provider);
    template.models[0].base_instructions = "User-authored coding instructions";
    await writeFile(catalogPath, JSON.stringify(template));
    expect(await readBonsaiCatalog({ ...provider, catalogPath })).toEqual(template);
    template.models[0].slug = "other";
    await writeFile(catalogPath, JSON.stringify(template));
    await expect(readBonsaiCatalog({ ...provider, catalogPath })).rejects.toThrow("exactly the configured model");
    template.models[0].slug = provider.models![0];
    template.models[0].context_window = 131072;
    await writeFile(catalogPath, JSON.stringify(template));
    await expect(readBonsaiCatalog({ ...provider, catalogPath })).rejects.toThrow("65536-token context");
  });
});
