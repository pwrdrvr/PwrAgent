import type { FederationInstanceId } from "@pwragent/shared";

export const FEDERATION_PEER_UNAVAILABLE_ERROR_CODE =
  "FEDERATION_PEER_UNAVAILABLE";

/**
 * Expected, transient loss of a route to a known federation peer.
 *
 * IPC read handlers catch this exact type and serve their last successful
 * snapshot instead of rejecting through Electron (which prints the entire
 * handler stack). Other errors remain exceptional and keep their diagnostics.
 */
export class FederationPeerUnavailableError extends Error {
  readonly code = FEDERATION_PEER_UNAVAILABLE_ERROR_CODE;

  constructor(
    readonly instanceId: FederationInstanceId,
    message = `Federation peer ${instanceId} is not connected.`,
  ) {
    super(message);
    this.name = "FederationPeerUnavailableError";
  }
}

export function isFederationPeerUnavailableError(
  error: unknown,
): error is FederationPeerUnavailableError {
  return error instanceof FederationPeerUnavailableError
    || (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === FEDERATION_PEER_UNAVAILABLE_ERROR_CODE
    );
}
