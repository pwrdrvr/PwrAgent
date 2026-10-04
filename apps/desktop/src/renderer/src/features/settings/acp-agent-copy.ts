import type {
  AcpAgentSettingsEntry,
  DesktopUpdateChannel,
} from "@pwragent/shared";

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
 * The version inside a PwrAgent build tag: `pwragent-v1.0.12-pwragent.2` reads
 * as `1.0.12-pwragent.2`. grok-build and pwrdrvr/codex share the prefix, and it
 * is the same on every tag, so in a control that shows two of them side by side
 * it is noise.
 */
export function managedBuildVersion(tag: string): string {
  return tag.startsWith("pwragent-v") ? tag.slice("pwragent-v".length) : tag;
}

/**
 * The Build track row, shared by every provider with a PwrAgent build so the
 * tracks read the same wherever an operator meets them.
 */
export const MANAGED_BUILD_TRACK_SUB =
  "Latest installs promoted builds only. Prerelease installs the newest build whether or not it has been promoted — and stays selectable while both tracks name the same version, which is where a build sits between publication and promotion.";

const MANAGED_BUILD_CHANNEL_OPTIONS: Array<{
  label: string;
  value: DesktopUpdateChannel;
}> = [
  { label: "Latest", value: "latest" },
  { label: "Prerelease", value: "prerelease" },
];

/**
 * Both tracks, each labelled with the version it resolves to as of the last
 * release check.
 *
 * "Unavailable" is not "there is no such build": a check that fell back to the
 * public Atom feed can only speak for one track, and no check has run at all
 * before the first install.
 */
export function managedBuildTrackOptions(tags: {
  latestTag?: string;
  prereleaseTag?: string;
}): Array<{ label: string; meta: string; value: DesktopUpdateChannel }> {
  return MANAGED_BUILD_CHANNEL_OPTIONS.map((option) => {
    const tag =
      option.value === "latest" ? tags.latestTag : tags.prereleaseTag;
    return { ...option, meta: tag ? managedBuildVersion(tag) : "Unavailable" };
  });
}
