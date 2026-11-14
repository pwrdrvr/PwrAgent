import { getMainLogger } from "../log";

export const isDevelopment = process.env.NODE_ENV !== "production";
const backendRegistryLog = getMainLogger("pwragent:backend-registry");

export function logDebug(event: string, payload: Record<string, unknown>): void {
  if (!isDevelopment) {
    return;
  }

  backendRegistryLog.debug(event, payload);
}
