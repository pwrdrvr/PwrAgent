export type RelayBatch = { epoch: number; sequence: number; channel: "media" | "feedback" | "ready" | "close"; items: string[] };
export const RELAY_BATCH_BYTES: number, RELAY_WINDOW_BYTES: number, RELAY_SLOTS: number;
export function validateRelayBatch(batch: unknown, role: "source" | "viewer"): RelayBatch;
