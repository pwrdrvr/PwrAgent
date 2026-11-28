import {
  isCodexVersionBelowMinimum,
  parseCodexVersionCore,
} from "@pwragent/shared/codex-version";
import type {
  DesktopCodexCandidateSource,
  DesktopCodexInstaller,
} from "@pwragent/shared/contracts/settings";

/**
 * Installers whose own update command PwrAgent may run for the operator. Each
 * is recognized from the path its Codex really lives at, and each updates in
 * place at that path. Nothing outside this set is ever run: an `application`
 * Codex belongs to an app that updates itself, `pwragent` is PwrAgent's own
 * build with its own channel, and `unknown` would mean guessing.
 */
export const CODEX_RUNNABLE_UPDATE_INSTALLERS: ReadonlySet<DesktopCodexInstaller> = new Set([
  "homebrew",
  "npm",
  "pnpm",
  "bun",
  "standalone",
]);

/** What PwrAgent launches today, as the settings service knows it. */
export type CodexUpdateTarget = {
  command: string;
  version: string;
  source?: DesktopCodexCandidateSource;
  managedByPwrAgent: boolean;
  /** OpenAI's Codex that PwrAgent installed; PwrAgent updates it itself. */
  openAiInstalledByPwrAgent?: boolean;
};

/** A newer stock Codex exists than the one PwrAgent launches. */
export type CodexUserUpdateOffer = {
  /** `major.minor.patch` of the Codex PwrAgent launches. */
  installedVersion: string;
  /** `major.minor.patch` of the newest stock release. */
  latestVersion: string;
  installer: DesktopCodexInstaller;
  /** What the operator would type to update; shown and copied. */
  upgradeCommand?: string;
  /** PwrAgent can run `upgradeCommand` itself. */
  canRunUpdate: boolean;
};

export type CodexUserUpdatePhase =
  /** The installer is running. */
  | "updating"
  /** It exited cleanly; PwrAgent is reading the new version. */
  | "verifying"
  /** A newer Codex is in place; PwrAgent is starting a new app server. */
  | "restarting"
  | "succeeded"
  /** The installer exited cleanly but the version did not move. */
  | "unchanged"
  | "failed";

export const CODEX_USER_UPDATE_ACTIVE_PHASES: ReadonlySet<CodexUserUpdatePhase> = new Set([
  "updating",
  "verifying",
  "restarting",
]);

export type CodexUserUpdateRun = {
  /** Increases with every run in this process, so a result is dismissed once. */
  id: number;
  phase: CodexUserUpdatePhase;
  installer: DesktopCodexInstaller;
  fromVersion: string;
  targetVersion: string;
  /** The version found after the installer ran. */
  toVersion?: string;
  error?: string;
  /** The installer's last output lines, for a failure. Memory only. */
  outputTail?: string;
  /** What ran, as the operator would type it. */
  upgradeCommand?: string;
  startedAt: number;
  updatedAt: number;
};

export type CodexUserUpdateState = {
  offer?: CodexUserUpdateOffer;
  run?: CodexUserUpdateRun;
};

/**
 * Whether to offer an update, and which kind. The offer exists exactly when
 * the installed core version is below the latest one and the Codex is not
 * one PwrAgent installed (its own build, or OpenAI's Codex it keeps current). It may be run only when the installer is one
 * PwrAgent recognizes, it has a command, and the caller found the tool to run
 * it with.
 */
export function deriveCodexUserUpdateOffer(params: {
  installedVersion: string | undefined;
  latestVersion: string | undefined;
  installer: DesktopCodexInstaller;
  upgradeCommand?: string;
  /** The installer's tool was found on this machine. */
  runnable: boolean;
}): CodexUserUpdateOffer | undefined {
  // PwrAgent keeps both of its own installs current on their own schedule.
  if (params.installer === "pwragent" || params.installer === "pwragent-openai") return undefined;
  const installed = parseCodexVersionCore(params.installedVersion);
  const latest = parseCodexVersionCore(params.latestVersion);
  if (!installed || !latest) return undefined;
  const installedVersion = installed.join(".");
  const latestVersion = latest.join(".");
  if (!isCodexVersionBelowMinimum(installedVersion, latestVersion)) return undefined;
  const canRunUpdate = params.runnable
    && params.upgradeCommand !== undefined
    && CODEX_RUNNABLE_UPDATE_INSTALLERS.has(params.installer);
  return {
    installedVersion,
    latestVersion,
    installer: params.installer,
    ...(params.upgradeCommand ? { upgradeCommand: params.upgradeCommand } : {}),
    canRunUpdate,
  };
}

/** The installer's name as a sentence uses it. */
export function codexInstallerLabel(installer: DesktopCodexInstaller): string {
  switch (installer) {
    case "homebrew": return "Homebrew";
    case "npm": return "npm";
    case "pnpm": return "pnpm";
    case "bun": return "bun";
    case "standalone": return "the Codex installer";
    case "application": return "the Codex app";
    case "pwragent": return "PwrAgent";
    case "pwragent-openai": return "PwrAgent";
    case "unknown": return "its installer";
  }
}
