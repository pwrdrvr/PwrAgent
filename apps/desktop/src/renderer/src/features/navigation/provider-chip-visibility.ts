import { createContext, useContext, useMemo } from "react";
import type { AppServerBackendKind } from "@pwragent/shared";

/**
 * The providers that own at least one thread, from the owner's directory
 * index (it counts every thread, not one loaded page). Undefined until that
 * index arrives, and from an owner too old to report it.
 */
export const ThreadProvidersContext = createContext<
  readonly AppServerBackendKind[] | undefined
>(undefined);

/**
 * A provider chip only helps when it tells threads apart. With every thread
 * on one provider, "OpenAI" on each row and header is noise, so it hides
 * until a second provider has a thread. A provider no thread uses yet (a
 * launchpad set to Claude while every thread is OpenAI) still shows. An
 * unknown list shows the chip, which is the behavior before this rule.
 */
export function providerChipNeeded(
  providers: readonly AppServerBackendKind[] | undefined,
  backend: AppServerBackendKind,
): boolean {
  if (!providers) return true;
  if (providers.length > 1) return true;
  return providers.length === 1 && providers[0] !== backend;
}

/** An unnamed provider keeps its chip: there is nothing to compare. */
export function useProviderChipNeeded(backend: AppServerBackendKind | undefined): boolean {
  const providers = useContext(ThreadProvidersContext);
  return backend === undefined || providerChipNeeded(providers, backend);
}

/**
 * Keeps one array identity while the provider list's contents stay the same,
 * so a refreshed page does not re-render every chip that reads the context.
 */
export function useStableThreadProviders(
  providers: readonly AppServerBackendKind[] | undefined,
): readonly AppServerBackendKind[] | undefined {
  const key = providers?.join("\n");
  return useMemo(
    () => key === undefined
      ? undefined
      : key.split("\n").filter(Boolean) as AppServerBackendKind[],
    [key],
  );
}
