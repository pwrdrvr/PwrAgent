/** Expected offline/cancelled navigation state crosses IPC as data so Electron does not log a handler stack. */
export type NavigationReadFailure = {
  navigationReadFailure: true;
  code: "FEDERATION_PEER_UNAVAILABLE" | "navigation_busy";
  message: string;
  instanceId?: string;
};

export function expectedNavigationReadFailure(error: unknown): NavigationReadFailure | undefined {
  if (!(error instanceof Error) || !("code" in error) || (error.code !== "FEDERATION_PEER_UNAVAILABLE" && error.code !== "navigation_busy")) return undefined;
  return { navigationReadFailure: true, code: error.code, message: error.message,
    ...("instanceId" in error && typeof error.instanceId === "string" ? { instanceId: error.instanceId } : {}) };
}

/** Keep the renderer API's rejection contract, including the owner and machine-readable code. */
export function unwrapNavigationRead<T>(result: T | NavigationReadFailure): T {
  if (result && typeof result === "object" && "navigationReadFailure" in result && result.navigationReadFailure === true) {
    const failure = result as NavigationReadFailure;
    throw Object.assign(new Error(failure.message), { name: failure.code === "navigation_busy" ? "NavigationQueryError" : "FederationPeerUnavailableError", code: failure.code,
      ...(failure.instanceId ? { instanceId: failure.instanceId } : {}) });
  }
  return result as T;
}
