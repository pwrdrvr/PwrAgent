import fs from "node:fs";
import path from "node:path";
import { resolveActiveProfilePath } from "../profile";

/**
 * One advisory per local profile, including across application restarts.
 *
 * Each caller owns a marker file naming its own advisory; the mechanics of
 * delivering once, only to a real consumer, are the same for all of them.
 */
export class OneTimeProfileNotice {
  private notified = false;
  private pending = false;

  constructor(
    private readonly markerPath: string,
    private readonly onPersistenceError: (error: unknown) => void = () => {},
  ) {}

  /** The marker for `name`, under the active profile's notice directory. */
  static markerFor(name: string): string {
    return resolveActiveProfilePath(path.join("state", "notices", name));
  }

  publish(deliveries: Array<() => void>): void {
    // A background lookup before any window subscribes must not consume it.
    if (this.notified || deliveries.length === 0) return;
    if (fs.existsSync(this.markerPath)) {
      this.notified = true;
      return;
    }
    this.pending = true;
    for (const deliver of deliveries) deliver();
  }

  acknowledge(): void {
    if (this.notified || !this.pending) return;
    this.notified = true;
    try {
      fs.mkdirSync(path.dirname(this.markerPath), { recursive: true });
      // Exclusive creation also deduplicates processes sharing a profile.
      fs.closeSync(fs.openSync(this.markerPath, "wx", 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
      // A read-only profile must not break the caller or repeat forever.
      this.onPersistenceError(error);
    }
  }
}
