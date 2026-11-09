import type {
  AppServerBackendKind,
  FederationInstanceId,
  ThreadIdentifier,
} from "@pwragent/shared";

/**
 * Durable viewer-side knowledge of which federation instance owns a thread.
 * This is routing metadata only; transcripts and provider-owned thread state
 * remain on the owning instance.
 */
export type RemoteThreadTarget = {
  instanceId: FederationInstanceId;
  instanceLabel: string;
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  firstSeenAt: number;
  lastSeenAt: number;
};

export type RemoteThreadTargetStore = {
  rememberRemoteThreadTarget(params: {
    instanceId: FederationInstanceId;
    instanceLabel: string;
    backend: AppServerBackendKind;
    threadId: ThreadIdentifier;
    observedAt?: number;
  }): Promise<RemoteThreadTarget>;
  listRemoteThreadTargets(params: {
    backend: AppServerBackendKind;
    threadId: ThreadIdentifier;
  }): Promise<RemoteThreadTarget[]>;
};
