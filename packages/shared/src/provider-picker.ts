import { codexProviderIdOfModel } from "./codex-model-providers";
import { modelMenuEntryProviderId } from "./model-menu";
import type {
  BackendModelOption,
  CodexModelProviderCatalogState,
} from "./contracts/backend";
import type { AppServerBackendKind } from "./contracts/normalized-app-server";

/**
 * The Provider picker: one entry per backend, and one more per Codex model
 * provider the owner registered.
 *
 * A Codex model provider is not a backend. Its threads run on the `codex`
 * backend, and the provider is fixed by the qualified model id
 * (`@<provider>/<model>`). The picker still names it the way the operator
 * named it, so a MathOS thread is chosen as MathOS rather than as OpenAI.
 * The entry's value is therefore the backend kind for a backend, and a
 * `codex-provider:<id>` value for a Codex model provider, which no backend
 * kind can equal.
 */

const CODEX_MODEL_PROVIDER_VALUE_PREFIX = "codex-provider:";

/** The catalog fields the picker reads from a backend summary. */
export type ProviderPickerBackend = {
  kind: AppServerBackendKind;
  launchpadOptions?: { models?: readonly BackendModelOption[] };
  codexModelProviders?: readonly CodexModelProviderCatalogState[];
};

export type ProviderPickerEntry = {
  value: string;
  backend: AppServerBackendKind;
  /** Set on a Codex model provider's entry. */
  codexModelProviderId?: string;
  /** Set on a Codex model provider's entry: its display name. */
  label?: string;
  /** The models this entry offers. Only a Codex entry lists them. */
  models: BackendModelOption[];
  /** The owner's catalog state, when it reported one. */
  catalog?: CodexModelProviderCatalogState;
};

export function codexModelProviderPickerValue(providerId: string): string {
  return `${CODEX_MODEL_PROVIDER_VALUE_PREFIX}${providerId}`;
}

/** The picker entry a backend plus model belongs to. */
export function providerPickerValue(
  backend: AppServerBackendKind,
  model: string | undefined,
): string {
  const providerId = backend === "codex" ? codexProviderIdOfModel(model) : undefined;
  return providerId ? codexModelProviderPickerValue(providerId) : backend;
}

export function parseProviderPickerValue(value: string): {
  backend: AppServerBackendKind;
  codexModelProviderId?: string;
} {
  return value.startsWith(CODEX_MODEL_PROVIDER_VALUE_PREFIX)
    ? { backend: "codex", codexModelProviderId: value.slice(CODEX_MODEL_PROVIDER_VALUE_PREFIX.length) }
    : { backend: value as AppServerBackendKind };
}

/**
 * The picker's entries, in backend order. Codex's own entry is followed by
 * its model providers, in the order the owner registered them. A provider
 * whose catalog read failed and that lists no model still gets an entry, so
 * the picker can say why it offers nothing. An owner that predates
 * `codexModelProviders` still reports `providerId` on each model, and its
 * providers come from those.
 */
export function buildProviderPickerEntries(
  backends: readonly ProviderPickerBackend[],
): ProviderPickerEntry[] {
  const entries: ProviderPickerEntry[] = [];
  for (const backend of backends) {
    const models = backend.launchpadOptions?.models ?? [];
    if (backend.kind !== "codex") {
      entries.push({ value: backend.kind, backend: backend.kind, models: [...models] });
      continue;
    }
    entries.push({
      value: "codex",
      backend: "codex",
      models: models.filter((model) => !modelMenuEntryProviderId(model)),
    });
    const byProvider = new Map<string, ProviderPickerEntry>();
    const providerEntry = (id: string, label: string): ProviderPickerEntry => {
      let entry = byProvider.get(id);
      if (!entry) {
        entry = {
          value: codexModelProviderPickerValue(id),
          backend: "codex",
          codexModelProviderId: id,
          label,
          models: [],
        };
        byProvider.set(id, entry);
      }
      return entry;
    };
    for (const state of backend.codexModelProviders ?? []) {
      providerEntry(state.id, state.name || state.id).catalog = state;
    }
    for (const model of models) {
      const providerId = modelMenuEntryProviderId(model);
      if (!providerId) continue;
      providerEntry(providerId, model.providerLabel || providerId).models.push(model);
    }
    entries.push(...byProvider.values());
  }
  return entries;
}

/**
 * Each Codex model provider's display name in an owner's backend list, by
 * provider id. The owner's catalog state names it first, then a model's
 * `providerLabel`.
 */
export function codexModelProviderLabels(
  backends: readonly ProviderPickerBackend[] | undefined,
): Map<string, string> {
  const labels = new Map<string, string>();
  const codex = backends?.find((backend) => backend.kind === "codex");
  for (const state of codex?.codexModelProviders ?? []) {
    if (state.name) labels.set(state.id, state.name);
  }
  for (const model of codex?.launchpadOptions?.models ?? []) {
    const providerId = modelMenuEntryProviderId(model);
    if (providerId && model.providerLabel && !labels.has(providerId)) labels.set(providerId, model.providerLabel);
  }
  return labels;
}

/**
 * The display name of a Codex model provider in an owner's backend list, or
 * undefined when that owner reports no such provider.
 */
export function findCodexModelProviderLabel(
  backends: readonly ProviderPickerBackend[] | undefined,
  providerId: string,
): string | undefined {
  return codexModelProviderLabels(backends).get(providerId);
}

function countModels(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "model" : "models"}`;
}

/**
 * The line under a Codex model provider's picker entry, and whether the
 * entry can be chosen. An entry with no model cannot.
 */
export function describeCodexModelProviderEntry(entry: ProviderPickerEntry): {
  description: string;
  disabled: boolean;
} {
  const count = entry.models.length;
  const catalog = entry.catalog;
  if (count === 0) {
    return {
      description: catalog?.status === "unavailable" && catalog.error
        ? `No models. Catalog unavailable: ${catalog.error}`
        : catalog?.status === "pending"
          ? "No models yet. Reading its catalog."
          : "No models. List one in Settings.",
      disabled: true,
    };
  }
  const suffix = catalog?.status === "unavailable"
    ? " · catalog unavailable"
    : catalog?.truncated ? " (more not loaded)" : "";
  return { description: `Runs on Codex · ${countModels(count)}${suffix}`, disabled: false };
}

/**
 * A note under the Model menu when a provider's catalog is incomplete,
 * or undefined when it is whole.
 */
export function codexModelProviderCatalogNote(
  catalog: CodexModelProviderCatalogState | undefined,
): string | undefined {
  if (!catalog) return undefined;
  if (catalog.status === "unavailable") {
    return `Catalog unavailable${catalog.error ? `: ${catalog.error}` : ""}. Showing the models listed in Settings.`;
  }
  if (catalog.truncated) {
    return `${catalog.name} lists more models than PwrAgent loads. Showing the first ${countModels(catalog.discoveredCount ?? 0)}.`;
  }
  return undefined;
}
