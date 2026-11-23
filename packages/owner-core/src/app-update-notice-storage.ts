import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";

export type AppUpdateRestartReceipt = {
  backend: AppServerBackendKind;
  threadId: string;
  runtimeId: string;
  version: string;
  bindingId: string;
  destination: string;
  connectionId: string;
  observedVersion?: string;
};
