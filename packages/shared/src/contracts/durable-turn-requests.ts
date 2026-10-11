import type { StartTurnRequest, StartTurnResponse } from "./agent";
import type { AppServerThreadMessageOrigin } from "./normalized-app-server";

export const DURABLE_TURN_REQUEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export type DurableTurnPayload = Omit<StartTurnRequest, "queueEntryId" | "federationTarget"> & {
  messageOrigin?: AppServerThreadMessageOrigin;
  delivery?: "new_turn";
};
export type SubmitDurableTurnRequest = {
  clientRequest: { version: 1; id: string; createdAt: number; payloadHash: string };
  request: DurableTurnPayload;
};
export type GetDurableTurnRequest = {
  id: string;
  backend: StartTurnRequest["backend"];
  threadId: string;
};
export type DurableTurnReceipt = {
  version: 1;
  id: string;
  payloadHash: string;
  ownerInstanceId: string;
  backend: StartTurnRequest["backend"];
  threadId: string;
  queueEntryId: string;
  state: "accepted" | "dispatching" | "dispatched" | "completed" | "uncertain";
  acceptedAt: number;
  updatedAt: number;
  expiresAt: number;
  result?: StartTurnResponse;
  outcome?: "completed" | "failed" | "cancelled";
};
/** Delegation is namespaced under the authenticated Federation origin. */
export type FederationSubmitDurableTurnRequest = SubmitDurableTurnRequest & { callerScope?: string };
export type FederationGetDurableTurnRequest = GetDurableTurnRequest & { callerScope?: string };
