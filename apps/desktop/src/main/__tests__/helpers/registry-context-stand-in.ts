import type { AgentEvent } from "@pwragent/shared";
import type { RegistryContext } from "../../app-server/registry-context";

/**
 * A RegistryContext for an extracted module built outside the composition
 * root. Every store port group reads the one given store. The record is typed
 * by the context's own group names, so a new group fails to compile here
 * instead of reaching a module test as a missing port.
 */
export function registryContextStandIn(params: {
  overlayStore?: object;
  providers?: { codex?: object; claude?: object; acp?: object };
  lifecycle?: { readonly closed: boolean };
  emit?: (event: AgentEvent) => Promise<void>;
} = {}): RegistryContext {
  const store = params.overlayStore ?? {};
  const stores: Record<keyof RegistryContext["stores"], object> = {
    threads: store, usage: store, subAgents: store, workspaces: store, toolAccounting: store,
    pullRequests: store, reviews: store, archive: store, messaging: store, launchpads: store, directories: store,
  };
  return {
    stores,
    providers: params.providers ?? {},
    lifecycle: params.lifecycle ?? { closed: false },
    emit: params.emit ?? (async () => {}),
  } as unknown as RegistryContext;
}
