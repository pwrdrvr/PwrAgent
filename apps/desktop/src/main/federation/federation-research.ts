import {
  isRemoteFederationTarget,
  type FederationCapability,
  type FederationRemoteTarget,
  type FederationTarget,
} from "@pwragent/shared/contracts/federation";
import type { FederationRouter } from "./federation-router";
import type { localResearchOperations } from "../research/research-operations";

export type ResearchOperations = typeof localResearchOperations;
export type ResearchOperation = keyof ResearchOperations;
export type ResearchOperationRequest<K extends ResearchOperation> = Parameters<ResearchOperations[K]>[0];
export type ResearchOperationResponse<K extends ResearchOperation> = Awaited<ReturnType<ResearchOperations[K]>>;
export type ResearchRemoteRequest = <K extends ResearchOperation>(
  target: FederationRemoteTarget,
  operation: K,
  request: ResearchOperationRequest<K>,
) => Promise<ResearchOperationResponse<K>>;

export const FEDERATION_RESEARCH_METHODS = {
  snapshot: "research.snapshot",
  changes: "research.changes",
  events: "research.events",
  search: "research.search",
  readItem: "research.readItem",
  work: "research.work",
  prepare: "research.prepare",
  withdraw: "research.withdraw",
  update: "research.update",
  harnessStatus: "research.harnessStatus",
  harnessCheck: "research.harnessCheck",
  harnessStart: "research.harnessStart",
  harnessReconcile: "research.harnessReconcile",
  listMathosSwarms: "research.listMathosSwarms",
} as const satisfies Record<ResearchOperation, string>;

/**
 * Reads require `thread_detail`; mutations and run/harness dispatch require
 * `turn_control`. Contained peers are denied by `FederationRouter`.
 */
export const FEDERATION_RESEARCH_CAPABILITIES: Record<string, FederationCapability> = {
  [FEDERATION_RESEARCH_METHODS.snapshot]: "thread_detail",
  [FEDERATION_RESEARCH_METHODS.changes]: "thread_detail",
  [FEDERATION_RESEARCH_METHODS.events]: "thread_detail",
  [FEDERATION_RESEARCH_METHODS.search]: "thread_detail",
  [FEDERATION_RESEARCH_METHODS.readItem]: "thread_detail",
  [FEDERATION_RESEARCH_METHODS.harnessStatus]: "thread_detail",
  [FEDERATION_RESEARCH_METHODS.harnessCheck]: "thread_detail",
  [FEDERATION_RESEARCH_METHODS.listMathosSwarms]: "thread_detail",
  [FEDERATION_RESEARCH_METHODS.work]: "turn_control",
  [FEDERATION_RESEARCH_METHODS.prepare]: "turn_control",
  [FEDERATION_RESEARCH_METHODS.withdraw]: "turn_control",
  [FEDERATION_RESEARCH_METHODS.update]: "turn_control",
  [FEDERATION_RESEARCH_METHODS.harnessStart]: "turn_control",
  [FEDERATION_RESEARCH_METHODS.harnessReconcile]: "turn_control",
};

/**
 * Operations whose owner work (network swarm listing, Harness bridge/model
 * calls, or worker cancellation) may legitimately outlast the default 30s RPC
 * timeout.
 */
export const LONG_RUNNING_FEDERATION_RESEARCH_OPERATIONS: ReadonlySet<ResearchOperation> = new Set([
  "update",
  "harnessCheck",
  "harnessStart",
  "harnessReconcile",
  "listMathosSwarms",
]);

export function registerFederationResearchHandlers(
  router: FederationRouter,
  operations: ResearchOperations,
): void {
  for (const operation of Object.keys(FEDERATION_RESEARCH_METHODS) as ResearchOperation[]) {
    router.registerHandler(FEDERATION_RESEARCH_METHODS[operation], (envelope) => {
      const request = (envelope.params ?? {}) as { federationTarget?: unknown };
      if (request.federationTarget !== undefined) {
        throw new Error("Research requests must terminate at their owner.");
      }
      // Dispatch only to the owner-local operation, never back through viewer routing.
      return (operations[operation] as (request: unknown) => unknown)(request);
    });
  }
}

/**
 * Routes each Research operation to the thread's owning instance. A remote
 * viewer (either a remote window or a mounted remote thread in the local main
 * window) never falls back to local Research services.
 */
export class FederatedResearchService {
  constructor(private readonly options: {
    local: ResearchOperations;
    remote: ResearchRemoteRequest;
  }) {}

  async request<K extends ResearchOperation>(
    operation: K,
    input: (ResearchOperationRequest<K> & { federationTarget?: FederationTarget }) | undefined,
    windowTarget?: FederationRemoteTarget,
  ): Promise<ResearchOperationResponse<K>> {
    const request = (input && typeof input === "object" ? { ...input } : {}) as Record<string, unknown>;
    const explicit = request.federationTarget as FederationTarget | undefined;
    delete request.federationTarget;
    if (explicit !== undefined) {
      if (explicit.scope === "local") {
        if (windowTarget) {
          throw new Error("Research owner does not match this window.");
        }
      } else if (isRemoteFederationTarget(explicit)) {
        if (windowTarget && windowTarget.instanceId !== explicit.instanceId) {
          throw new Error("Research owner does not match its target.");
        }
      } else {
        throw new Error("Invalid research owner target.");
      }
    }
    const target = explicit?.scope === "remote" ? explicit : windowTarget;
    if (target) {
      return await this.options.remote(target, operation, request as ResearchOperationRequest<K>);
    }
    return await (this.options.local[operation] as (
      request: unknown,
    ) => Promise<ResearchOperationResponse<K>> | ResearchOperationResponse<K>)(request);
  }
}
