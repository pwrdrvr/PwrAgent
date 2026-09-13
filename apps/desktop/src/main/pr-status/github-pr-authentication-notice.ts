import fs from "node:fs";
import path from "node:path";
import { resolveActiveProfilePath } from "../profile";

/** One advisory per local profile, including across application restarts. */
export class GithubPrAuthenticationNotice {
  private notified = false;

  constructor(
    private readonly markerPath = resolveActiveProfilePath(
      path.join("state", "notices", "github-pr-authentication-failure"),
    ),
    private readonly onPersistenceError: (error: unknown) => void = () => {},
  ) {}

  publish(deliveries: Array<() => void>): void {
    // A background lookup before any window subscribes must not consume it.
    if (this.notified || deliveries.length === 0) return;
    this.notified = true;
    try {
      fs.mkdirSync(path.dirname(this.markerPath), { recursive: true });
      // Exclusive creation also deduplicates processes sharing a profile.
      fs.closeSync(fs.openSync(this.markerPath, "wx", 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
      // A read-only profile must not break PR polling or repeat every poll.
      this.onPersistenceError(error);
    }
    for (const deliver of deliveries) deliver();
  }
}
