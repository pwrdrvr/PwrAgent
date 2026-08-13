import type { AppServerBackendKind } from "@pwragent/shared";

export type WindowShowThreadRequest = {
  backend: AppServerBackendKind;
  /** Transcript message to reveal after selecting the thread. */
  messageId?: string;
  threadId: string;
};
