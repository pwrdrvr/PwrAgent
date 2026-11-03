import type { AppServerBackendKind, BackendLaunchpadOptions } from "@pwragent/shared";

type RequestedModelSettings = {
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  fastMode?: boolean;
};

/** Validate new requests before defaults can silently discard an invalid choice. */
export function assertThreadModelSettingsAvailable(
  backend: AppServerBackendKind,
  options: BackendLaunchpadOptions | undefined,
  requested: RequestedModelSettings,
  resolvedModel?: string,
): void {
  const models = options?.models ?? [];
  const model = models.find((candidate) => candidate.id === (requested.model ?? resolvedModel));
  if (requested.model !== undefined && !model) {
    throw new Error(`model="${requested.model}" is not available for backend="${backend}". Available models: ${models.map((candidate) => candidate.id).join(", ") || "none discovered; refresh the provider catalog and retry"}.`);
  }
  if (requested.reasoningEffort !== undefined) {
    const efforts = model?.supportsReasoning
      ? model.reasoningEfforts ?? options?.reasoningEfforts ?? []
      : [];
    if (!efforts.includes(requested.reasoningEffort)) {
      throw new Error(`reasoningEffort="${requested.reasoningEffort}" is not supported for backend="${backend}", model="${model?.id ?? "default"}". Available reasoning efforts: ${efforts.join(", ") || "none; omit reasoningEffort"}.`);
    }
  }
  const supportsFast = backend === "codex" && model?.supportsFast === true;
  if (requested.fastMode === true && !supportsFast) {
    throw new Error(`fastMode=true is not supported for backend="${backend}", model="${model?.id ?? "default"}". Omit fastMode or choose a model that supports Fast.`);
  }
  if (requested.serviceTier !== undefined) {
    const tiers = backend === "codex"
      ? model?.serviceTiers ?? options?.serviceTiers ?? []
      : [];
    const tier = requested.serviceTier === "fast" ? "priority" : requested.serviceTier;
    if (!tiers.includes(tier) && !(tier === "priority" && supportsFast)) {
      throw new Error(`serviceTier="${requested.serviceTier}" is not supported for backend="${backend}", model="${model?.id ?? "default"}". Available service tiers: ${tiers.join(", ") || (supportsFast ? "priority" : "none; omit serviceTier")}.`);
    }
  }
}
