import type { AppServerBackendKind, FederationRemoteTarget, ListOperatorRequestsRequest, ListOperatorRequestsResponse, MarkOperatorItemsSeenRequest } from "@pwragent/shared";
import { parseRemoteOperatorItemKey, projectOperatorItemKey } from "@pwragent/shared";
import type { OperatorQuestionOperation, OperatorQuestionOperationRequest, OperatorQuestionOperationResponse } from "./federation-operator-questions";

/** Queue projections never copy remote requests or seen state into the viewer database. */
export class FederatedOperatorRequestService {
  constructor(private readonly options: {
    localList: () => ListOperatorRequestsResponse;
    localMarkSeen: (keys: string[]) => void;
    remote: <K extends OperatorQuestionOperation>(target: FederationRemoteTarget, operation: K,
      request: OperatorQuestionOperationRequest<K>) => Promise<OperatorQuestionOperationResponse<K>>;
    mountedThreads: () => Promise<Array<{ target: FederationRemoteTarget; backend: AppServerBackendKind; threadId: string }>>;
    onUnavailable?: (error: unknown) => void;
  }) {}

  async list(request: ListOperatorRequestsRequest = {}, windowTarget?: FederationRemoteTarget): Promise<ListOperatorRequestsResponse> {
    const { federationTarget, ...filter } = request;
    const target = federationTarget ?? windowTarget;
    if (target) {
      const [response, serverRequests] = await Promise.all([
        this.options.remote(target, "list", filter),
        this.options.remote(target, "listPending", filter),
      ]);
      return {
        serverRequests: serverRequests.map((entry) => ({ ...entry, federationTarget: target })),
        questions: response.questions.map((entry) => ({ ...entry, federationTarget: target })),
        seenKeys: response.seenKeys.map((key) => projectOperatorItemKey(key, target)),
      };
    }
    const local = this.options.localList();
    const response: ListOperatorRequestsResponse = {
      ...local,
      seenKeys: [...local.seenKeys],
      questions: local.questions.filter((entry) => (!filter.backend || entry.backend === filter.backend)
        && (!filter.threadId || entry.threadId === filter.threadId)),
      serverRequests: local.serverRequests.filter((entry) => (!filter.backend || entry.backend === filter.backend)
        && (!filter.threadId || entry.notification.params.threadId === filter.threadId)),
    };
    const mounts = new Map((await this.options.mountedThreads()).filter((mount) =>
      (!filter.backend || mount.backend === filter.backend) && (!filter.threadId || mount.threadId === filter.threadId))
      .map((mount) => [JSON.stringify([mount.target.instanceId, mount.backend, mount.threadId]), mount]));
    const remote = await Promise.all([...mounts.values()].map(async (mount) => {
      try {
        return await this.list({ backend: mount.backend, threadId: mount.threadId, federationTarget: mount.target });
      } catch (error) {
        this.options.onUnavailable?.(error);
        (response.errors ??= []).push(`${mount.target.instanceId}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    }));
    for (const listed of remote) {
      if (!listed) continue;
      response.questions.push(...listed.questions);
      response.serverRequests.push(...listed.serverRequests);
      response.seenKeys.push(...listed.seenKeys);
    }
    response.seenKeys = [...new Set(response.seenKeys)];
    return response;
  }

  async markSeen(request: MarkOperatorItemsSeenRequest, windowTarget?: FederationRemoteTarget): Promise<void> {
    const groups = new Map<string, { target?: FederationRemoteTarget; keys: string[] }>();
    for (const key of (Array.isArray(request?.keys) ? request.keys : []).slice(0, 500)) {
      if (typeof key !== "string") continue;
      const projected = parseRemoteOperatorItemKey(key);
      const explicit = request.federationTarget ?? windowTarget;
      if (projected && explicit && projected.target.instanceId !== explicit.instanceId) {
        throw new Error("Operator item owner does not match its target.");
      }
      const target = projected?.target ?? explicit;
      const group = groups.get(target?.instanceId ?? "") ?? { target, keys: [] };
      group.keys.push(projected?.key ?? key);
      groups.set(target?.instanceId ?? "", group);
    }
    await Promise.all([...groups.values()].map(async ({ target, keys }) => {
      if (target) await this.options.remote(target, "markSeen", { keys });
      else this.options.localMarkSeen(keys);
    }));
  }
}
