import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CodexModelProviderSettings } from "@pwragent/shared";
import { resolveActiveProfilePath } from "../profile";
import { discoverModelCatalog, startBridge, type LocalModelCatalog } from "./local-responses-bridge.mjs";

export async function readBonsaiCatalog(provider: CodexModelProviderSettings): Promise<LocalModelCatalog> {
  const slug = provider.models?.[0];
  if (provider.compatibility !== "bonsai" || provider.models?.length !== 1 || !slug) {
    throw new Error("Bonsai compatibility requires exactly one configured model.");
  }
  if (provider.catalogPath) {
    const info = await stat(provider.catalogPath);
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error("The Bonsai catalog must be a JSON file smaller than 1 MiB.");
    const catalog = JSON.parse(await readFile(provider.catalogPath, "utf8")) as LocalModelCatalog;
    if (!Array.isArray(catalog?.models) || catalog.models.length !== 1 || catalog.models[0]?.slug !== slug) {
      throw new Error("The Bonsai catalog must describe exactly the configured model.");
    }
    const model = catalog.models[0];
    if (model.context_window !== 65536 || model.apply_patch_tool_type !== null
      || model.supports_search_tool === true || model.supports_reasoning_summaries === true
      || !Array.isArray(model.supported_reasoning_levels) || model.supported_reasoning_levels.length !== 0) {
      throw new Error("The Bonsai catalog needs a 65536-token context, function tools, and no search or reasoning support.");
    }
    return catalog;
  }
  return { models: [{
    slug,
    display_name: "PrismML Bonsai",
    description: "Local Bonsai through PwrAgent's Responses compatibility bridge",
    default_reasoning_level: null,
    supported_reasoning_levels: [],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    base_instructions: "You are a coding assistant. Use the available tools to inspect files, make requested changes, and verify your work.",
    supports_reasoning_summaries: false,
    supports_reasoning_summary_parameter: false,
    default_reasoning_summary: "none",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    truncation_policy: { mode: "tokens", limit: 10000 },
    context_window: 65536,
    experimental_supported_tools: [],
    input_modalities: ["text"],
    supports_search_tool: false,
  }] };
}

/** Resources live exactly as long as this provider's App Server process. */
export async function prepareBonsaiRuntime(provider: CodexModelProviderSettings): Promise<{
  overrides: string[];
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const catalog = await discoverModelCatalog(provider.baseUrl, await readBonsaiCatalog(provider));
  const root = resolveActiveProfilePath("runtime");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(root, "bonsai-"));
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  const close = async () => {
    if (bridge) {
      const server = bridge;
      bridge = undefined;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const catalogPath = path.join(directory, "models.json");
    await writeFile(catalogPath, JSON.stringify(catalog), { mode: 0o600 });
    bridge = await startBridge(provider.baseUrl);
    const address = bridge.address();
    if (!address || typeof address === "string") throw new Error("The Bonsai bridge has no loopback address.");
    return {
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      overrides: [
        `model=${JSON.stringify(provider.models![0])}`,
        `model_provider=${JSON.stringify(provider.id)}`,
        `model_providers.${provider.id}.base_url="http://127.0.0.1:${address.port}/v1"`,
        `model_providers.${provider.id}.supports_websockets=false`,
        `model_catalog_json=${JSON.stringify(catalogPath)}`,
        "model_context_window=65536",
        "model_auto_compact_token_limit=49152",
        'model_reasoning_effort="none"',
        'model_reasoning_summary="none"',
        'web_search="disabled"',
        "features.multi_agent=false",
        "features.goals=false",
        "features.apps=false",
        "features.plugins=false",
        "features.image_generation=false",
      ],
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
