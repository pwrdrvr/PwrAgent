import type { AcpAgentSettingsEntry } from "@pwragent/shared";

export function acpInstallDisclosure(entry: AcpAgentSettingsEntry): string {
  const verification =
    entry.verificationStatus === "unverified-allowed"
      ? " This binary source does not publish checksum metadata."
      : "";
  return `PwrAgent will run ${entry.distributionSource} as a third-party ACP agent.${verification}`;
}

export function acpStatusLabel(entry: AcpAgentSettingsEntry): string {
  if (entry.installed && entry.authStatus === "required") {
    return "Installed - setup required";
  }
  if (entry.installed) {
    return "Installed";
  }
  if (entry.installStatus === "install-failed") {
    return "Install failed";
  }
  if (!entry.installable) {
    return "Unavailable";
  }
  return "Ready to install";
}
