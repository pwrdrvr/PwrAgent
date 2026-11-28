import {
  CODEX_USER_UPDATE_ACTIVE_PHASES,
  codexInstallerLabel,
  type CodexUserUpdateState,
} from "../../../../shared/codex-user-update";

export type CodexUpdatePillTone = "available" | "loading" | "success" | "warning" | "error";

export type CodexUpdatePillAction =
  | { kind: "update"; label: string }
  | { kind: "copy"; label: string; command: string }
  | { kind: "releases"; label: string }
  | { kind: "retry"; label: string };

export type CodexUpdatePillView = {
  /** Changes whenever the pill means something new, so a dismissal is per meaning. */
  key: string;
  tone: CodexUpdatePillTone;
  title: string;
  description: string;
  action?: CodexUpdatePillAction;
  /** Dismissal keys this pill retires. An in-flight run has none. */
  dismissKeys: string[];
  /** A finished success clears itself after this long. */
  autoDismissMs?: number;
};

export const CODEX_UPDATE_SUCCESS_VISIBLE_MS = 8_000;

export function codexUpdateOfferDismissKey(latestVersion: string): string {
  return `offer:${latestVersion}`;
}

export function codexUpdateRunDismissKey(runId: number): string {
  return `run:${runId}`;
}

function firstLine(text: string | undefined): string | undefined {
  return text?.split("\n").map((line) => line.trim()).find(Boolean);
}

/**
 * What the sidebar's Codex update pill says, or nothing. A run in progress
 * always shows and cannot be dismissed; a finished run shows until dismissed
 * and, when dismissed, also retires the offer it was trying to satisfy so the
 * pill does not immediately ask again for the same release.
 */
export function buildCodexUpdatePillView(
  state: CodexUserUpdateState | undefined,
  dismissed: ReadonlySet<string>,
): CodexUpdatePillView | undefined {
  const run = state?.run;
  if (run && CODEX_USER_UPDATE_ACTIVE_PHASES.has(run.phase)) {
    const installer = codexInstallerLabel(run.installer);
    return {
      key: `${codexUpdateRunDismissKey(run.id)}:${run.phase}`,
      tone: "loading",
      title: "Updating Codex",
      description: run.phase === "updating"
        ? `Installing ${run.targetVersion} with ${installer}…`
        : run.phase === "verifying"
          ? "Checking the installed version…"
          : `Starting Codex ${run.toVersion ?? run.targetVersion}…`,
      dismissKeys: [],
    };
  }
  if (run && !dismissed.has(codexUpdateRunDismissKey(run.id))) {
    const dismissKeys = [
      codexUpdateRunDismissKey(run.id),
      codexUpdateOfferDismissKey(run.targetVersion),
    ];
    const key = `${codexUpdateRunDismissKey(run.id)}:${run.phase}`;
    if (run.phase === "succeeded") {
      return {
        key,
        tone: "success",
        title: `Codex updated to ${run.toVersion ?? run.targetVersion}`,
        description: "New turns use it. Running turns finish first.",
        dismissKeys,
        autoDismissMs: CODEX_UPDATE_SUCCESS_VISIBLE_MS,
      };
    }
    if (run.phase === "unchanged") {
      return {
        key,
        tone: "warning",
        title: `Codex is still ${run.toVersion ?? run.fromVersion}`,
        description: `${capitalize(codexInstallerLabel(run.installer))} has no Codex ${run.targetVersion} yet. Try again later.`,
        dismissKeys,
      };
    }
    return {
      key,
      tone: "error",
      title: "Codex update failed",
      description: firstLine(run.error) ?? "The update did not finish.",
      action: { kind: "retry", label: "Try again" },
      dismissKeys,
    };
  }
  const offer = state?.offer;
  if (!offer || dismissed.has(codexUpdateOfferDismissKey(offer.latestVersion))) {
    return undefined;
  }
  const base = {
    key: codexUpdateOfferDismissKey(offer.latestVersion),
    tone: "available" as const,
    title: `Codex ${offer.latestVersion} available`,
    dismissKeys: [codexUpdateOfferDismissKey(offer.latestVersion)],
  };
  if (offer.canRunUpdate) {
    return {
      ...base,
      description: `You have ${offer.installedVersion}. Updates with ${codexInstallerLabel(offer.installer)}.`,
      action: { kind: "update", label: "Update" },
    };
  }
  if (offer.upgradeCommand) {
    return {
      ...base,
      description: `You have ${offer.installedVersion}. Run the command in a terminal.`,
      action: { kind: "copy", label: "Copy command", command: offer.upgradeCommand },
    };
  }
  if (offer.installer === "application") {
    return {
      ...base,
      description: `You have ${offer.installedVersion}. Update the ChatGPT or Codex app.`,
    };
  }
  return {
    ...base,
    description: `You have ${offer.installedVersion}. Update it the way you installed it.`,
    action: { kind: "releases", label: "Releases" },
  };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
