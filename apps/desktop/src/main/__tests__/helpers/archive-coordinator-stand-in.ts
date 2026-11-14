import type { AgentEvent } from "@pwragent/shared";
import { DEFAULT_CHECKOUT_HIBERNATION_POLICY, DEFAULT_THREAD_ARCHIVE_POLICY } from "@pwragent/shared";
import type { RegistryContext } from "../../app-server/registry-context";
import {
  ThreadArchiveCoordinator,
  type ThreadArchiveCoordinatorDependencies,
} from "../../app-server/thread-archive-coordinator";

/**
 * A real archive coordinator for a registry stand-in built from the
 * registry's prototype or a plain object. The registry reads archive,
 * hibernation and restore state through its coordinator, so a stand-in
 * without one reaches none of it. The coordinator reads the given store and
 * providers, and the stand-in as its host, as the composition root's ports
 * are the registry.
 */
export function archiveCoordinatorStandIn(params: {
  registry?: () => object;
  overlayStore?: object;
  providers?: { codex?: object; claude?: object; acp?: object };
  lifecycle?: { readonly closed: boolean };
  emit?: (event: AgentEvent) => Promise<void>;
  dependencies?: Partial<ThreadArchiveCoordinatorDependencies>;
}): ThreadArchiveCoordinator {
  const store = params.overlayStore ?? {};
  const context = {
    stores: {
      threads: store, usage: store, subAgents: store, workspaces: store, toolAccounting: store,
      pullRequests: store, reviews: store, archive: store, messaging: store,
    },
    providers: params.providers ?? {},
    lifecycle: params.lifecycle ?? { closed: false },
    emit: params.emit ?? (async () => {}),
  };
  return new ThreadArchiveCoordinator(context as unknown as RegistryContext, {
    managedMaintenanceRoots: async () => [],
    readThreadArchivePolicy: () => ({ ...DEFAULT_THREAD_ARCHIVE_POLICY }),
    readCheckoutHibernationPolicy: () => ({ ...DEFAULT_CHECKOUT_HIBERNATION_POLICY }),
    worktreeContainerService: {} as never,
    ...params.dependencies,
  }, {}, () => (params.registry?.() ?? {}) as never);
}
