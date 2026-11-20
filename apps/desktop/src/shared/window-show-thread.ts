import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import type { FederationRemoteTarget } from "@pwragent/shared/contracts/federation";

export type WindowShowThreadRequest = {
  backend: AppServerBackendKind;
  /** Owning peer when the thread is mounted into a local viewer. */
  federationTarget?: FederationRemoteTarget;
  /** Transcript message to reveal after selecting the thread. */
  messageId?: string;
  threadId: string;
};
