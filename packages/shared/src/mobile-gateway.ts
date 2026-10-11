import type { AppServerBackendKind, AppServerReadThreadResponse } from "./contracts/normalized-app-server";
import type { NavigationRow } from "./contracts/navigation";

export const MOBILE_PROTOCOL = 1;
export type MobileScope = "read" | "send" | "voice";
export type MobileTarget = { instanceId: string; backend: AppServerBackendKind; threadId: string };
export type MobileMachine = { id: string; label: string; available: boolean; canSend: boolean; canSteer?: boolean };
export type MobileThread = { target: MobileTarget; machineLabel: string; row: NavigationRow };
export type MobilePage = { machines?: MobileMachine[]; threads: MobileThread[]; cursors: Record<string, string>; errors: Record<string, string> };
export type MobileSnapshot = { target: MobileTarget; response: AppServerReadThreadResponse };
export type MobileHello = { protocol: 1; gatewayId: string; deviceId: string; scopes: MobileScope[]; machines: MobileMachine[]; capabilities: string[] };
export type MobileCredential = { url: string; token: string; deviceId: string; gatewayId: string };
export type MobileRpcRequest = { id: string; method: string; params: unknown };
export type MobileRpcResponse = { id: string; result?: unknown; error?: { code: string; message: string } };
export type MobileEvent = { event: "changed"; target?: MobileTarget } | { event: "voice"; data: { sessionId: string; type: string; sdp?: string; text?: string; role?: string; done?: boolean; message?: string; reason?: string; tool?: string; ok?: boolean; target?: string } };
export function mobileThreadKey(target: MobileTarget): string {
  return JSON.stringify([target.instanceId, target.backend, target.threadId]);
}
