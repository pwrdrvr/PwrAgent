// What Settings → Git → Updates says and offers, as pure functions.
//
// Split from the component for the same reason as the progress strip's copy:
// the states and their buttons are the interesting part, and neither needs a
// DOM to be checked.

import type {
  DesktopGitRuntimeChoice,
  DesktopManagedGitSnapshot,
} from "@pwragent/shared";
import { formatByteCount } from "../../lib/format-bytes";

export type ManagedGitUpdatesTone = "ok" | "notice" | "error" | "idle";

export type ManagedGitUpdatesAction =
  | { kind: "download"; tag: string; label: string; primary: boolean }
  | { kind: "use"; generation: string; label: string; primary: boolean }
  | { kind: "rollback"; choice: DesktopGitRuntimeChoice; label: string; primary: boolean }
  | { kind: "check"; label: string; primary: boolean };

export type ManagedGitUpdatesCopy = {
  tone: ManagedGitUpdatesTone;
  /** The version the line leads with, in mono. */
  tag?: string;
  message: string;
  /** A second, quieter line. */
  note?: string;
  actions: ManagedGitUpdatesAction[];
};

export function managedGitChoiceLabel(
  choice: DesktopGitRuntimeChoice,
  managed: Pick<DesktopManagedGitSnapshot, "bundledVersion">,
): string {
  switch (choice.kind) {
    case "bundled":
      return `Bundled ${managed.bundledVersion}`;
    case "managed":
      return `Downloaded ${choice.generation.replace(/-[0-9a-f]{7}$/u, "")}`;
    case "path":
      return "Custom path";
  }
}

function checkedAgo(checkedAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - checkedAt) / 60_000));
  if (minutes < 1) return "Checked just now.";
  if (minutes < 60) return `Checked ${minutes} minute${minutes === 1 ? "" : "s"} ago.`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Checked ${hours} hour${hours === 1 ? "" : "s"} ago.`;
  const days = Math.round(hours / 24);
  return `Checked ${days} day${days === 1 ? "" : "s"} ago.`;
}

/**
 * The Updates row for one snapshot. `currentKind` says which Git this
 * profile runs (an explicit path wins over a downloaded release).
 */
export function managedGitUpdatesCopy(
  managed: DesktopManagedGitSnapshot,
  options: { now: number; manualPathSelected: boolean },
): ManagedGitUpdatesCopy {
  const check = managed.check;
  const selected = managed.selected && !options.manualPathSelected
    ? managed.releases.find((release) => release.generation === managed.selected)
    : undefined;
  const previous = managed.previous;
  const rollback: ManagedGitUpdatesAction[] = previous
    && !(previous.kind === "managed" && previous.generation === managed.selected && !options.manualPathSelected)
    ? [{ kind: "rollback", choice: previous, label: `Roll back to ${managedGitChoiceLabel(previous, managed)}`, primary: false }]
    : [];
  const checkAction = (label: string): ManagedGitUpdatesAction => ({ kind: "check", label, primary: false });

  // A chosen release that failed its checks: nothing else matters until the
  // operator picks another Git, because PwrAgent will not run this one.
  if (managed.selected && !options.manualPathSelected) {
    const failure = selected?.failure
      ?? (selected ? undefined : `${managed.selected} is no longer installed.`);
    if (failure) {
      return {
        tone: "error",
        tag: managed.selected,
        message: `Failed verification: ${failure} Git commands fail until you choose another Git.`,
        actions: [
          ...rollback.map((action) => ({ ...action, primary: true })),
          ...(rollback.length === 0
            ? [{ kind: "rollback", choice: { kind: "bundled" }, label: `Use Bundled ${managed.bundledVersion}`, primary: true } as const]
            : []),
        ],
      };
    }
  }

  const available = check?.available;
  const installedAvailable = available
    ? managed.releases.find((release) => release.generation === available.generation)
    : undefined;
  const actions: ManagedGitUpdatesAction[] = [];
  let tone: ManagedGitUpdatesTone = "idle";
  let tag: string | undefined;
  let message: string;
  let note: string | undefined;

  if (available && !installedAvailable) {
    tone = "notice";
    tag = available.version;
    message = `is available${available.archiveBytes ? ` (${formatByteCount(available.archiveBytes)})` : ""}. Bundled: ${managed.bundledVersion}.`;
    note = "Downloading does not switch Git. You choose when to use it.";
    actions.push({ kind: "download", tag: available.tag, label: `Download ${available.version}`, primary: true });
    actions.push(checkAction("Check again"));
  } else if (installedAvailable && installedAvailable.generation !== selected?.generation) {
    tone = "notice";
    tag = installedAvailable.version;
    message = "is downloaded and verified. Not in use yet.";
    actions.push({ kind: "use", generation: installedAvailable.generation, label: `Use ${installedAvailable.version}`, primary: true });
    actions.push(checkAction("Check for updates"));
  } else if (selected) {
    tone = "ok";
    tag = selected.version;
    message = `is in use.${check ? ` ${checkedAgo(check.checkedAt, options.now)}` : ""}`;
    note = "Commands already running finish on the Git they started with.";
    actions.push(checkAction("Check for updates"));
  } else {
    tone = "ok";
    tag = managed.bundledVersion;
    message = check && !check.error
      ? `is the newest PwrDrvr Git. ${checkedAgo(check.checkedAt, options.now)}`
      : "is bundled with PwrAgent.";
    actions.push(checkAction("Check for updates"));
  }
  actions.push(...rollback);

  if (check?.error) {
    tone = "notice";
    note = `Could not check for updates: ${check.error}${managed.releases.length > 0 ? " Installed builds still work." : ""}`;
  } else if (check?.needsAppUpdate) {
    note = `${check.needsAppUpdate.version} needs a newer PwrAgent. Update PwrAgent to use it.`;
  }
  return { tone, ...(tag ? { tag } : {}), message, ...(note ? { note } : {}), actions };
}
