import { createContext, useContext, useMemo } from "react";
import {
  providerChipNeeded,
  threadProviderIdentity,
  type AppServerBackendKind,
} from "@pwragent/shared";

export { providerChipNeeded };

/**
 * The providers that own at least one thread, from the owner's directory
 * index (it counts every thread, not one loaded page): its provider
 * identities (`NavigationCounts.providers`), or its backend kinds from an
 * owner that predates them. Undefined until that index arrives, and from an
 * owner too old to report either.
 */
export const ThreadProvidersContext = createContext<readonly string[] | undefined>(undefined);

/**
 * An unnamed provider keeps its chip: there is nothing to compare. A Codex
 * thread on a registered model provider (`@mathos/…`) is compared as that
 * provider, so a MathOS row among OpenAI rows keeps its chip and a list of
 * MathOS rows alone drops it. An owner that reports only backend kinds lists
 * `codex`, which a MathOS row never equals, so the chip stays on there.
 */
export function useProviderChipNeeded(
  backend: AppServerBackendKind | undefined,
  model?: string,
): boolean {
  const providers = useContext(ThreadProvidersContext);
  return backend === undefined || providerChipNeeded(providers, threadProviderIdentity(backend, model));
}

/**
 * Keeps one array identity while the provider list's contents stay the same,
 * so a refreshed page does not re-render every chip that reads the context.
 */
export function useStableThreadProviders(
  providers: readonly string[] | undefined,
): readonly string[] | undefined {
  const key = providers?.join("\n");
  return useMemo(
    () => key === undefined ? undefined : key.split("\n").filter(Boolean),
    [key],
  );
}
