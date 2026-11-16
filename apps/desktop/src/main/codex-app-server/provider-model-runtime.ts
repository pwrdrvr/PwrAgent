import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { codexProviderContextWindow, type CodexModelProviderSettings, type CodexProviderCatalogModel } from "@pwragent/shared";
import { resolveActiveProfilePath } from "../profile";

/** A provider's capabilities must never replace the default provider's catalog. */
export async function prepareProviderModelRuntime(provider: CodexModelProviderSettings): Promise<{
  overrides: string[];
  close: () => Promise<void>;
}> {
  const metadata = new Map((provider.modelMetadata ?? []).map((model) => [model.id, model]));
  const ids = [...new Set([...(provider.models ?? []), ...metadata.keys()])];
  if (!ids.length) throw new Error("Provider execution metadata needs at least one model.");
  const models = ids.map((id) => ({
    ...modelDescriptor(metadata.get(id) ?? { id }, provider),
    ...(provider.toolDiscovery === "portable" ? { tool_mode: "code_mode_only", supports_search_tool: true } : {}),
  }));
  const contextWindow = Math.max(...models.map((model) => model.context_window));
  // Codex process overrides apply to every model in this provider. Reserve
  // 25% of its smallest working set, so changing models cannot overrun it.
  const compactLimit = Math.min(...models.map((model) => model.auto_compact_token_limit));
  const root = resolveActiveProfilePath("runtime");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(root, "provider-models-"));
  try {
    const catalogPath = path.join(directory, "models.json");
    await writeFile(catalogPath, JSON.stringify({ models }), { mode: 0o600 });
    return {
      overrides: [
        `model_provider=${JSON.stringify(provider.id)}`,
        `model=${JSON.stringify(ids[0])}`,
        `model_catalog_json=${JSON.stringify(catalogPath)}`,
        // Override inherited global limits only in this provider's process.
        // Codex clamps this ceiling to each catalog model's max_context_window.
        `model_context_window=${contextWindow}`,
        `model_auto_compact_token_limit=${compactLimit}`,
      ],
      close: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function modelDescriptor(model: CodexProviderCatalogModel, provider: CodexModelProviderSettings) {
  const contextWindow = codexProviderContextWindow(provider, model);
  return {
    slug: model.id, display_name: model.label ?? model.id,
    description: "Provider execution metadata configured in PwrAgent",
    default_reasoning_level: model.defaultReasoningEffort ?? null,
    supported_reasoning_levels: (model.reasoningEfforts ?? []).map((effort) => ({ effort, description: effort })),
    shell_type: "unified_exec", visibility: "list", supported_in_api: true, priority: 0,
    additional_speed_tiers: [], service_tiers: [], availability_nux: null, upgrade: null,
    base_instructions: "You are a coding assistant. Use the available tools to inspect files, make requested changes, and verify your work.",
    supports_reasoning_summaries: false, supports_reasoning_summary_parameter: false,
    default_reasoning_summary: "none", support_verbosity: false, default_verbosity: null,
    apply_patch_tool_type: null, truncation_policy: { mode: "bytes", limit: 10000 },
    context_window: contextWindow,
    max_context_window: contextWindow,
    auto_compact_token_limit: Math.floor(contextWindow * 0.75),
    experimental_supported_tools: [],
    ...(model.supportsImage === undefined ? {} : { input_modalities: model.supportsImage ? ["text", "image"] : ["text"] }),
    supports_search_tool: model.supportsSearchTool === true,
  };
}
