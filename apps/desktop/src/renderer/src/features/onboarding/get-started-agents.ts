import type { AcpAgentSettingsEntry, BackendSummary } from "@pwragent/shared/contracts/backend";
import type { DesktopSettingsSnapshot } from "@pwragent/shared/contracts/settings";

/**
 * Get started's reading of each agent on this computer. One state per row,
 * and one action per state, so a row never offers two competing next steps.
 */
export type GetStartedAgentState =
  | { kind: "checking" }
  | { kind: "not-installed" }
  /** Installed, but switched off in this profile. */
  | { kind: "off" }
  | { kind: "needs-sign-in"; detail?: string }
  | { kind: "ready"; detail?: string }
  | { kind: "error"; detail: string };

export type GetStartedAgentAction =
  | "install"
  | "turn-on"
  | "sign-in"
  | "check-again"
  | "none";

/** The single next step a row offers. Ready and checking rows offer none. */
export function getStartedAgentAction(state: GetStartedAgentState): GetStartedAgentAction {
  switch (state.kind) {
    case "not-installed":
      return "install";
    case "off":
      return "turn-on";
    case "needs-sign-in":
      return "sign-in";
    case "error":
      return "check-again";
    case "checking":
    case "ready":
      return "none";
  }
}

/** Start waits for one ready agent. Every other state is a reason to wait. */
export function canStartWithAgents(states: readonly GetStartedAgentState[]): boolean {
  return states.some((state) => state.kind === "ready");
}

/** Codex sign-in, as the auth status check last reported it. */
export type CodexSignInState =
  | { kind: "unknown" }
  | { kind: "checking" }
  | { kind: "starting" }
  | { kind: "waiting"; url?: string }
  | { kind: "signed-in"; email?: string; planType?: string }
  /** `cancelled`: the user stopped a sign-in this page started. */
  | { kind: "signed-out"; detail?: string; cancelled?: boolean }
  | { kind: "error"; detail: string; url?: string };

export function selectedCodexCandidate(snapshot: DesktopSettingsSnapshot | undefined) {
  return snapshot?.models.codex.discovery.candidates.find(
    (candidate) =>
      candidate.selected
      && candidate.executable
      && Boolean(candidate.version)
      && !candidate.failureReason
      && !candidate.versionFailureReason,
  );
}

/**
 * Codex's row. A separate login is made after setup, in the new profile, so
 * an installed Codex is ready for that choice whatever this computer's own
 * login says.
 */
export function codexAgentState(params: {
  snapshot: DesktopSettingsSnapshot | undefined;
  discovering: boolean;
  signIn: CodexSignInState;
  separateLogin: boolean;
}): GetStartedAgentState {
  const candidate = selectedCodexCandidate(params.snapshot);
  if (!candidate) {
    return params.discovering ? { kind: "checking" } : { kind: "not-installed" };
  }
  if (params.separateLogin) {
    return { kind: "ready", detail: "Sign in after setup, in the new profile" };
  }
  switch (params.signIn.kind) {
    case "signed-in": {
      const bits = [params.signIn.email, params.signIn.planType].filter(Boolean);
      return { kind: "ready", detail: bits.length > 0 ? bits.join(" · ") : "Signed in" };
    }
    case "unknown":
    case "checking":
      return { kind: "checking" };
    case "starting":
    case "waiting":
      return { kind: "needs-sign-in", detail: "Finish signing in in your browser" };
    case "signed-out":
      return { kind: "needs-sign-in", detail: params.signIn.detail };
    case "error":
      return { kind: "error", detail: params.signIn.detail };
  }
}

/**
 * Why Get started should offer PwrAgent's own Codex build, if it should.
 *
 * T3 Code and similar apps install Codex for the user instead of leaving them
 * at a terminal. PwrAgent already ships a verified Codex build, so the three
 * dead ends a new user can hit all lead to the same one-click install:
 * - `missing`: no Codex at all;
 * - `broken`: a Codex was found but does not start;
 * - `outdated`: a working Codex too old for the newest models.
 * An environment-forced path is the operator's decision, so it gets no offer.
 */
export type CodexInstallOffer =
  | { reason: "missing" }
  | { reason: "broken"; command: string }
  | { reason: "outdated"; version: string; minimumVersion: string };

export function codexInstallOffer(params: {
  snapshot: DesktopSettingsSnapshot | undefined;
  discovering: boolean;
  /** The Codex discovery found but could not start, if any. */
  launchFailure?: { command: string };
}): CodexInstallOffer | undefined {
  const codex = params.snapshot?.models?.codex;
  if (!codex || codex.path?.source === "env") return undefined;
  if (!selectedCodexCandidate(params.snapshot)) {
    if (params.discovering) return undefined;
    return params.launchFailure
      ? { reason: "broken", command: params.launchFailure.command }
      : { reason: "missing" };
  }
  const advisory = codex.versionAdvisory;
  const managedOn = codex.managedBuildsRequiredBy !== undefined || codex.managedBuilds?.value === true;
  if (advisory && advisory.installer !== "pwragent" && !managedOn) {
    return { reason: "outdated", version: advisory.version, minimumVersion: advisory.minimumVersion };
  }
  return undefined;
}

/** An ACP agent's row, from its discovery entry and its enabled setting. */
export function acpAgentState(params: {
  entry: AcpAgentSettingsEntry | undefined;
  entriesLoaded: boolean;
  enabled: boolean;
}): GetStartedAgentState {
  if (!params.entry) {
    return params.entriesLoaded ? { kind: "not-installed" } : { kind: "checking" };
  }
  if (!params.entry.installed) return { kind: "not-installed" };
  if (!params.enabled) return { kind: "off" };
  return {
    kind: "ready",
    ...(params.entry.version ? { detail: `Version ${params.entry.version}` } : {}),
  };
}

/**
 * Claude Code's row, from the owner's backend summary. `loaded` says the
 * summaries have been read, so a missing summary means no Claude Code.
 */
export function claudeAgentState(
  backend: BackendSummary | undefined,
  loaded: boolean,
): GetStartedAgentState {
  const claude = backend?.claude;
  if (!backend || !claude) return loaded ? { kind: "not-installed" } : { kind: "checking" };
  if (backend.discoveryPending) return { kind: "checking" };
  if (!claude.executable) return { kind: "not-installed" };
  switch (claude.authStatus) {
    case "signed-in":
      return {
        kind: "ready",
        detail: claude.source === "bundled" ? "Bundled with PwrAgent" : "Signed in",
      };
    case "sign-in-required":
      return { kind: "needs-sign-in" };
    case "session-expired":
      return { kind: "needs-sign-in", detail: "Your sign-in expired" };
    case "unknown":
      return { kind: "error", detail: claude.message ?? "PwrAgent couldn't check Claude Code's sign-in." };
  }
}
