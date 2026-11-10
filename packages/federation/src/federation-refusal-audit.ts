import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import type { FederationRefusalAudit } from "./federation-router";

/** Private, rotated JSONL. No request payload, SQLite transaction, timer or queue. */
export function appendFederationRefusalAudit(directory: string, event: FederationRefusalAudit): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "federation-refusals.jsonl");
  try {
    if (statSync(file).size >= 8 * 1024 * 1024) renameSync(file, `${file}.previous`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  appendFileSync(file, `${JSON.stringify({ peerId: event.peerId, method: event.method.slice(0, 256),
    role: event.role, createdAt: event.createdAt })}\n`, { mode: 0o600 });
}
