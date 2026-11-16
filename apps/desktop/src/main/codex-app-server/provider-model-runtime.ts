import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CodexModelProviderSettings, CodexProviderCatalogModel } from "@pwragent/shared";
import { resolveActiveProfilePath } from "../profile";

/** A provider's capabilities must never replace the default provider's catalog. */
export async function prepareProviderModelRuntime(provider: CodexModelProviderSettings): Promise<{
  overrides: string[];
  close: () => Promise<void>;
}> {
  const metadata = new Map((provider.modelMetadata ?? []).map((model) => [model.id, model]));
  const ids = [...new Set([...(provider.models ?? []), ...metadata.keys()])];
  if (!ids.length) throw new Error("Provider execution metadata needs at least one model.");
  const root = resolveActiveProfilePath("runtime");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(root, "provider-models-"));
  try {
    const catalogPath = path.join(directory, "models.json");
    await writeFile(catalogPath, JSON.stringify({ models: ids.map((id) => modelDescriptor(metadata.get(id) ?? { id })) }), { mode: 0o600 });
    return {
      overrides: [
        `model_provider=${JSON.stringify(provider.id)}`,
        `model=${JSON.stringify(ids[0])}`,
        `model_catalog_json=${JSON.stringify(catalogPath)}`,
      ],
      close: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function modelDescriptor(model: CodexProviderCatalogModel): Record<string, unknown> {
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
    // Preserve Codex 0.163's existing unknown-model limit and compaction
    // behavior when the endpoint supplied no context metadata.
    context_window: model.contextWindow ?? 272000,
    max_context_window: model.contextWindow ?? 272000,
    experimental_supported_tools: [],
    ...(model.supportsImage === undefined ? {} : { input_modalities: model.supportsImage ? ["text", "image"] : ["text"] }),
    supports_search_tool: model.supportsSearchTool === true,
  };
}
