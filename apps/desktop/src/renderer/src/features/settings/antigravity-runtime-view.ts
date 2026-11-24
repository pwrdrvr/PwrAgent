import type { AcpAgentSettingsEntry } from "@pwragent/shared/contracts/backend";
import {
  compareAntigravityVersions,
  type AntigravityReleaseStatus,
  type AntigravityRuntimeStatus,
} from "../../../../shared/antigravity-setup";

/**
 * What the Antigravity Runtime row says, and what the startup notice keys on.
 *
 * PwrAgent launches its managed `agy` with the CLI's own updater turned off,
 * so the only update path is PwrAgent asking Google's manifest and offering
 * the newer release. An update is offered exactly when that manifest names a
 * newer version than the managed install, and never without a managed install
 * (that state offers Install instead).
 */
export type AntigravityRuntimeView =
  | { kind: "loading" }
  | { kind: "unsupported" }
  | {
      kind: "not-installed";
      latestVersion?: string;
      checkedAt?: number;
      /** The Antigravity discovery found outside PwrAgent's managed copy. */
      detectedVersion?: string;
    }
  | {
      kind: "installed";
      version: string;
      command: string;
      /** New threads launch this managed release. */
      inUse: boolean;
      /**
       * Why new threads do not run it: Antigravity is off, discovery has not
       * named an active command yet, or another install is active.
       */
      notInUseReason?: "disabled" | "unknown" | "other-install";
      latestVersion?: string;
      checkedAt?: number;
      updateAvailable: boolean;
    };

export function antigravityRuntimeView(params: {
  runtime?: AntigravityRuntimeStatus;
  release?: AntigravityReleaseStatus;
  entry?: Partial<Pick<AcpAgentSettingsEntry, "activeCommand" | "enabled" | "installed" | "version">>;
}): AntigravityRuntimeView {
  const { runtime, release, entry } = params;
  if (!runtime) return { kind: "loading" };
  if (runtime.status === "unsupported") return { kind: "unsupported" };
  const latest = release
    ? { latestVersion: release.latestVersion, checkedAt: release.checkedAt }
    : {};
  if (runtime.status !== "installed") {
    return {
      kind: "not-installed",
      ...latest,
      ...(entry?.installed && entry.version ? { detectedVersion: entry.version } : {}),
    };
  }
  const { command, version } = runtime.runtime;
  const notInUseReason = entry?.enabled === false
    ? "disabled" as const
    : !entry?.activeCommand
      ? "unknown" as const
      : isManagedCommand(entry.activeCommand, command) ? undefined : "other-install" as const;
  return {
    kind: "installed",
    version,
    command,
    inUse: notInUseReason === undefined,
    ...(notInUseReason ? { notInUseReason } : {}),
    ...latest,
    updateAvailable: release !== undefined
      && compareAntigravityVersions(release.latestVersion, version) > 0,
  };
}

/**
 * The managed release is `<root>/versions/<release>/agy`, and `<root>/active`
 * links to it. Discovery can report either spelling for the same executable.
 */
function isManagedCommand(activeCommand: string | undefined, managedCommand: string): boolean {
  if (!activeCommand) return false;
  if (activeCommand === managedCommand) return true;
  const segments = managedCommand.split("/");
  return segments.length > 3
    && activeCommand === [...segments.slice(0, -3), "active"].join("/");
}

/**
 * The version a startup notice should offer, if any: only for a managed
 * install that new threads actually use, so an operator who picked their own
 * `agy` is not asked to update a copy they do not run.
 */
export function antigravityUpdateNoticeVersion(
  view: AntigravityRuntimeView,
  dismissedVersion?: string,
): string | undefined {
  if (
    view.kind !== "installed"
    || !view.inUse
    || !view.updateAvailable
    || !view.latestVersion
    || view.latestVersion === dismissedVersion
  ) {
    return undefined;
  }
  return view.latestVersion;
}
