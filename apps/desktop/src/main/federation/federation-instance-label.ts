import { execFileSync } from "node:child_process";
import { hostname, platform } from "node:os";

let cachedLabel: string | undefined;

/** Automatic label only; an operator-configured instance label takes priority. */
export function defaultInstanceLabel(): string {
  if (cachedLabel !== undefined) return cachedLabel;

  if (platform() === "darwin") {
    try {
      // macOS's network hostname can change with DHCP/reverse DNS. The
      // configured LocalHostName is stable across networks and profiles.
      const localName = execFileSync("/usr/sbin/scutil", ["--get", "LocalHostName"], {
        encoding: "utf8",
        timeout: 1_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (localName) {
        cachedLabel = localName;
        return cachedLabel;
      }
    } catch {
      // A missing/unavailable system name must not prevent federation startup.
    }
  }

  cachedLabel = hostname().trim().replace(/\.local$/i, "") || "PwrAgent";
  return cachedLabel;
}
