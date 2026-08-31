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
