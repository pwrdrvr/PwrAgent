import { createContext, useContext, useMemo } from "react";
import {
  codexModelProviderLabels,
  codexProviderIdOfModel,
  findCodexModelProviderLabel,
  type AppServerBackendKind,
  type BackendSummary,
  type FederationTarget,
  type ProviderPickerBackend,
} from "@pwragent/shared";
import { formatBackendLabel } from "./backend-label";

/**
 * The Codex model provider names a window can label a thread with, by
 * provider id: its own owner's, and each connected peer's whose threads it
 * lists.
 */
export type ThreadProviderCatalogs = {
  window: ReadonlyMap<string, string>;
  owners: ReadonlyMap<string, ReadonlyMap<string, string>>;
  windowInstanceId?: string;
};

export const ThreadProviderCatalogsContext = createContext<ThreadProviderCatalogs | undefined>(undefined);

type ThreadProviderSubject = {
  source: AppServerBackendKind;
  model?: string;
  federation?: { ref: { target: FederationTarget } };
};

/**
 * The name of the provider a thread runs on. A Codex thread on a registered
 * model provider (`@mathos/…`) is named the way its owner named the
 * provider, never "OpenAI". The name comes from the thread owner's own
 * catalog: a peer's thread is not named from this window's providers, which
 * may reuse the id for another endpoint. Without the owner's catalog the
 * provider id stands in.
 */
export function formatThreadProviderLabel(
  thread: ThreadProviderSubject,
  catalogs?: ThreadProviderCatalogs,
): string {
  const providerId = thread.source === "codex" ? codexProviderIdOfModel(thread.model) : undefined;
  if (!providerId) return formatBackendLabel(thread.source);
  const target = thread.federation?.ref.target;
  const ownerLabels = target?.scope === "remote" && target.instanceId !== catalogs?.windowInstanceId
    ? catalogs?.owners.get(target.instanceId)
    : catalogs?.window;
  return ownerLabels?.get(providerId) ?? providerId;
}

/**
 * The window's provider names, kept as one value while the names stay the
 * same. Backend summaries change with every rate-limit refresh, and every
 * thread row reads this context.
 */
export function useThreadProviderCatalogs(
  windowBackends: readonly ProviderPickerBackend[],
  ownerBackends: ReadonlyMap<string, readonly ProviderPickerBackend[]>,
  windowInstanceId: string | undefined,
): ThreadProviderCatalogs {
  const key = JSON.stringify([
    windowInstanceId ?? null,
    [...codexModelProviderLabels(windowBackends)],
    [...ownerBackends].map(([instanceId, backends]) => [instanceId, [...codexModelProviderLabels(backends)]]),
  ]);
  return useMemo(() => {
    const [instanceId, windowLabels, owners] = JSON.parse(key) as [
      string | null,
      Array<[string, string]>,
      Array<[string, Array<[string, string]>]>,
    ];
    return {
      window: new Map(windowLabels),
      owners: new Map(owners.map(([owner, labels]) => [owner, new Map(labels)])),
      ...(instanceId ? { windowInstanceId: instanceId } : {}),
    };
  }, [key]);
}

export function useThreadProviderLabel(thread: ThreadProviderSubject): string {
  return formatThreadProviderLabel(thread, useContext(ThreadProviderCatalogsContext));
}

/**
 * The same name, read from one owner's backend list, for a surface that has
 * the list in hand, such as the composer of a thread on that owner.
 */
export function formatOwnerProviderLabel(
  backend: AppServerBackendKind,
  model: string | undefined,
  backends: readonly BackendSummary[] | undefined,
): string {
  const providerId = backend === "codex" ? codexProviderIdOfModel(model) : undefined;
  if (!providerId) return formatBackendLabel(backend, backends ? [...backends] : undefined);
  return findCodexModelProviderLabel(backends, providerId) ?? providerId;
}
