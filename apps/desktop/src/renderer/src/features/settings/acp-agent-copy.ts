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
  return "Unavailable";
}
