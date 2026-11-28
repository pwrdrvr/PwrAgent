import { mkdir } from "node:fs/promises";
import path from "node:path";
import { withAntigravityUsageReservation } from "../storage/antigravity-usage-reservation-storage.js";
import { managedAntigravityRoot } from "./antigravity-runtime-retention.js";

/** All profiles sharing a PwrAgent root share the CLI attempt budget. */
export async function withAntigravityUsageCooldown<T>(
  read: (markStarted: () => void) => Promise<T>,
  root = managedAntigravityRoot(),
  now = Date.now,
  admit: () => boolean = () => true,
): Promise<T | undefined> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  return await withAntigravityUsageReservation(path.join(root, "usage-cooldown.db"), now, admit, read);
}
