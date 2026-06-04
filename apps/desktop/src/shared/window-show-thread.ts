import type { AppServerBackendKind } from "@pwragent/shared";

export type WindowShowThreadRequest = {
  backend: AppServerBackendKind;
  threadId: string;
};
