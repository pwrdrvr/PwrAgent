import type { AcpAgentSettingsEntry } from "@pwragent/shared";

export function acpStatusLabel(entry: AcpAgentSettingsEntry): string {
  if (entry.installed && entry.authStatus === "required") {
    return "Discovered - setup required";
  }
  if (entry.installed) {
    return "Discovered";
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
