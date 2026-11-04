import type {
  LaunchpadCreationStatus,
  MaterializeDirectoryLaunchpadRequest,
  MaterializeDirectoryLaunchpadResponse,
} from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";

export class LaunchpadStartupCancelledError extends Error {}

/** Keep the RPC unlimited; snapshots recover dropped notifications/responses. */
export async function materializeObservableLaunchpad(params: {
  api: Pick<DesktopApi, "manageLaunchpadCreation" | "materializeDirectoryLaunchpad">;
  request: MaterializeDirectoryLaunchpadRequest;
  onStatus: (status: LaunchpadCreationStatus) => void;
  onConnectionLost?: (lost: boolean) => void;
  wait?: () => Promise<void>;
}): Promise<MaterializeDirectoryLaunchpadResponse> {
  const { api, request } = params;
  if (!api.manageLaunchpadCreation || !api.materializeDirectoryLaunchpad || !request.operationId) {
    throw new Error("Upgrade this viewer and the owning instance to start threads with cancellation support. The draft has been retained.");
  }
  const identity = { operationId: request.operationId, federationTarget: request.federationTarget, action: "read" as const };
  // Verify support before submitting; an old owner must not silently ignore
  // operation identity and run an uncancellable request.
  try {
    await api.manageLaunchpadCreation(identity);
  } catch {
    throw new Error("The owner could not confirm startup cancellation support. Reconnect or upgrade it and retry. The draft has been retained.");
  }
  let response: MaterializeDirectoryLaunchpadResponse | undefined;
  let rpcError: unknown;
  let settled = false;
  let observed = false;
  const rpc = api.materializeDirectoryLaunchpad(request).then((result) => {
    response = result;
    settled = true;
  }, (error: unknown) => {
    rpcError = error;
    settled = true;
  });
  const wait = params.wait ?? (() => new Promise<void>((resolve) => window.setTimeout(resolve, 2000)));
  while (true) {
    // A disconnected request may reject while the owner continues. Never
    // resubmit it: read the same operation until the peer reconnects.
    let snapshot;
    try {
      snapshot = await api.manageLaunchpadCreation(identity);
      params.onConnectionLost?.(false);
    } catch {
      params.onConnectionLost?.(true);
      // Status is temporarily unavailable. Keep the pending row and its
      // identity so reconnect can resume observation or route Cancel again.
    }
    if (snapshot) {
      const { operation } = snapshot;
      if (operation) {
        observed = true;
        params.onStatus(operation);
        if (operation.phase === "completed" && operation.result) return operation.result;
        if (operation.phase === "cancelled") throw new LaunchpadStartupCancelledError(operation.error);
        if (operation.phase === "failed") throw new Error(operation.error ?? "Thread startup failed");
      } else if (observed) {
        throw new Error("The owner no longer has this startup operation. The draft has been retained; inspect the owner before retrying.");
      } else if (settled && rpcError) {
        throw rpcError;
      }
    }
    if (response) return response;
    if (!settled) await Promise.race([rpc, wait()]);
    else await wait();
  }
}
