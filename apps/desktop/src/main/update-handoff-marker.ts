import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { readPwragentHome } from "./pwragent-home";

/**
 * Cross-boot marker recording that we just handed a bundle swap to
 * Squirrel.Mac / ShipIt.
 *
 * A ShipIt install refuses to run while ANY instance of the target app is alive
 * — it aborts with SQRLInstallerErrorDomain -9 "App Still Running Error". So if
 * the app is reopened during the brief, feedback-less quit → install → relaunch
 * gap (a user who thinks the update stalled and relaunches it), the reopened
 * process strands the update in an abort/retry loop that only clears once the
 * app happens to stay closed long enough.
 *
 * We drop this marker right before `quitAndInstall()` and read it on the next
 * boot: if a swap is plausibly still in flight we step aside (quit immediately)
 * so ShipIt can finish, and ShipIt relaunches the updated build — whose boot
 * clears the marker via the version-match branch below.
 *
 * The marker is deliberately coarse and self-clearing (TTL + version match) so
 * a crashed or aborted install can never wedge the app closed.
 */

const MARKER_FILE = "update-handoff.json";

// A ShipIt swap can legitimately take a couple of minutes on a busy machine;
// past this we assume the install failed and boot normally rather than block
// launches indefinitely.
const HANDOFF_TTL_MS = 5 * 60_000;

type HandoffMarker = { targetVersion: string; at: number };

function pwragentHomeDir(): string {
  return readPwragentHome() ?? path.join(os.homedir(), ".pwragent");
}

function markerPath(): string {
  return path.join(pwragentHomeDir(), MARKER_FILE);
}

/**
 * Record that a Squirrel/ShipIt bundle swap for `targetVersion` is being handed
 * off. Best effort: the guard is a resilience nicety, never load-bearing, so a
 * write failure just falls back to today's behavior and must never throw into
 * the quit path.
 */
export function writeUpdateHandoffMarker(targetVersion: string): void {
  try {
    mkdirSync(pwragentHomeDir(), { recursive: true });
    const marker: HandoffMarker = { targetVersion, at: Date.now() };
    writeFileSync(markerPath(), JSON.stringify(marker), "utf8");
  } catch {
    // Intentionally swallowed — see doc comment.
  }
}

export function clearUpdateHandoffMarker(): void {
  try {
    rmSync(markerPath(), { force: true });
  } catch {
    // ignore
  }
}

/**
 * Whether this freshly-launched instance should quit immediately to let an
 * in-flight ShipIt bundle swap complete.
 *
 * Fails open: a missing, unreadable, corrupt, stale, or already-satisfied
 * marker returns false (clearing the marker where it makes sense) so the app
 * always boots when no install is actually underway.
 */
export function shouldStepAsideForUpdateInstall(
  currentVersion: string,
): boolean {
  let raw: string;
  try {
    if (!existsSync(markerPath())) return false;
    raw = readFileSync(markerPath(), "utf8");
  } catch {
    return false;
  }

  let marker: Partial<HandoffMarker>;
  try {
    marker = JSON.parse(raw) as Partial<HandoffMarker>;
  } catch {
    clearUpdateHandoffMarker();
    return false;
  }

  const { targetVersion, at } = marker;
  if (typeof targetVersion !== "string" || typeof at !== "number") {
    clearUpdateHandoffMarker();
    return false;
  }

  // The swap already landed — ShipIt relaunched us (or the user reopened after
  // it finished) and we ARE the target build. Clear and boot normally.
  if (currentVersion === targetVersion) {
    clearUpdateHandoffMarker();
    return false;
  }

  // Too old to still be installing: assume the install failed/aborted and boot
  // rather than wedge the app closed forever.
  if (Date.now() - at > HANDOFF_TTL_MS) {
    clearUpdateHandoffMarker();
    return false;
  }

  // Fresh handoff, still the old version: a ShipIt swap is very likely in
  // flight. Step aside; ShipIt relaunches the updated build and that boot
  // clears the marker via the version-match branch above.
  return true;
}
