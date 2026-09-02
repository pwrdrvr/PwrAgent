import type { AcpAgentSettingsEntry } from "@pwragent/shared";

export function acpStatusLabel(entry: AcpAgentSettingsEntry): string {
  if (entry.installed && entry.authStatus === "required") {
    return "Discovered - setup required";
  }
  if (entry.installed) {
    return "Discovered";
  }
  // Only an incompatible legacy CLI is on disk (e.g. the retired
  // Python kimi-cli). Plain "Not installed" copy would hide that the
  // operator has something to remediate.
  if (entry.incompatibleInstances?.length) {
    return "Legacy CLI - action required";
  }
  if (entry.installStatus === "install-failed") {
    return "Discovery failed";
  }
  if (entry.installStatus === "not-installed") {
    return "Not installed";
  }
  if (entry.rejectedInstances?.some((instance) => instance.reason === "probe-timed-out")) {
    return "Detected · check timed out";
  }
  if (entry.rejectedInstances?.length) {
    return "Detected · unavailable";
  }
  return "Unavailable";
}

/**
 * "2h ago" for a settings status line. Timestamps here report when PwrAgent
 * last did something on the operator's behalf (a release check), and the exact
 * clock time is never the question being asked.
 */
export function acpRelativeTime(timestamp: number, now = Date.now()): string {
  const deltaSeconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (deltaSeconds < 60) return "just now";
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  return `${Math.round(deltaHours / 24)}d ago`;
}

/**
 * The version inside a grok-build tag: `pwragent-v1.0.12-pwragent.2` reads as
 * `1.0.12-pwragent.2`. The repository prefix is the same on every tag, so in a
 * control that shows two of them side by side it is noise.
 */
export function managedGrokBuildVersion(tag: string): string {
  return tag.startsWith("pwragent-v") ? tag.slice("pwragent-v".length) : tag;
}
