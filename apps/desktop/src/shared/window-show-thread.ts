import type {
  AppServerBackendKind,
  FederationRemoteTarget,
} from "@pwragent/shared";

export type WindowShowThreadRequest = {
  backend: AppServerBackendKind;
  /** Owning peer when the thread is mounted into a local viewer. */
  federationTarget?: FederationRemoteTarget;
  /** Transcript message to reveal after selecting the thread. */
  messageId?: string;
  threadId: string;
};
