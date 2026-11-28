import type {
  AcpAgentSettingsEntry,
  BackendSummary,
} from "@pwragent/shared/contracts/backend";
import {
  isValidatedDiscoveryCandidate,
  type DesktopSettingsSnapshot,
} from "@pwragent/shared/contracts/settings";
import { formatFilesystemPath } from "@pwragent/shared/path-display";
import type { ManagedRuntimeProgress } from "../../../../shared/managed-runtime-progress";
import { acpRelativeTime, grokSignInRequired } from "./acp-agent-copy";
import { describeCommandDiscoveryFailure } from "./command-discovery-failure";
import type { SettingsChipTone } from "./SettingsLayout";

/*
 * Where an agent harness stands, in the order an operator sets one up:
 * turn it on (ACP agents only), find or install its runtime, sign in to the
 * provider account, then confirm it can start threads.
 *
 * This is the one reading of that state. The provider screen's Setup
 * checklist, its chip, the Settings nav dot, the AI Providers list and the
 * guided-setup review all render from it, so no two of them can describe
 * the same provider differently. It reads only what main already reports
 * and never starts a probe.
 */

export type HarnessSetupStepId = "enable" | "runtime" | "account" | "ready";

/**
 * - `done`: PwrAgent has a positive report for this step.
 * - `next`: the operator has to act here, and nothing has gone wrong.
 * - `attention`: this step failed, expired, or was refused.
 * - `working`: a check, download or sign-in is running.
 * - `unknown`: nothing has checked this step yet.
 * - `waiting`: an earlier step has to finish first.
 */
export type HarnessSetupStepState =
  | "done"
  | "next"
  | "attention"
  | "working"
  | "unknown"
  | "waiting";

/** The one thing that moves a step forward. */
export type HarnessSetupAction =
  | "enable"
  | "install"
  | "fix-path"
  | "sign-in"
  | "sign-in-again"
  | "terminal-sign-in"
  | "check"
  | "manage-account";

export type HarnessSetupStep = {
  id: HarnessSetupStepId;
  state: HarnessSetupStepState;
  /** Short state text shown after the step's title. */
  label: string;
  /** Observed facts: version, path, origin, account, when it was checked. */
  facts?: string[];
  /** One sentence on what is wrong or what to do. */
  detail?: string;
  action?: HarnessSetupAction;
};

export type HarnessSetupStatus = {
  /** Sentence-case label for the screen and provider-list chip. */
  label: string;
  tone: SettingsChipTone;
  /** Settings nav dot. Grey unless the provider is ready or needs a person. */
  dot: "ok" | "off" | "warn";
  /** Lower-case nav chip, only for states where the operator must act. */
  navChip?: string;
  /** What guided setup's review step says about this provider. */
  reviewLabel: string;
  /** Runtime found, account not known to be bad, last check succeeded. */
  ready: boolean;
  steps: HarnessSetupStep[];
  /** The action of the current step (`currentSetupStep`), if it has one. */
  action?: HarnessSetupAction;
};

export const HARNESS_SETUP_STEP_TITLES: Record<HarnessSetupStepId, string> = {
  enable: "Turn on",
  runtime: "Runtime",
  account: "Account",
  ready: "Ready for new threads",
};

const WAITING_FOR_RUNTIME: HarnessSetupStep = {
  id: "account",
  state: "waiting",
  label: "Waiting for the runtime",
};

function readyWaiting(after: number): HarnessSetupStep {
  return { id: "ready", state: "waiting", label: `After step ${after}` };
}

/** States in which a step is the one to act on. A waiting step is blocked
 *  behind an earlier one, and a done step is finished. */
const CURRENT_STATES: ReadonlySet<HarnessSetupStepState> = new Set([
  "next",
  "attention",
  "working",
  "unknown",
]);

/** The step the operator acts on now: the first that is not done or
 *  waiting. Setup puts its controls there and nowhere else. */
export function currentSetupStep(
  steps: readonly HarnessSetupStep[],
): HarnessSetupStep | undefined {
  return steps.find((step) => CURRENT_STATES.has(step.state));
}

function firstAction(steps: readonly HarnessSetupStep[]): HarnessSetupAction | undefined {
  return currentSetupStep(steps)?.action;
}

function status(
  head: Omit<HarnessSetupStatus, "steps" | "action" | "ready" | "reviewLabel"> & {
    reviewLabel?: string;
  },
  steps: HarnessSetupStep[],
): HarnessSetupStatus {
  const ready = steps.every((step) => step.state === "done");
  return {
    ...head,
    reviewLabel: head.reviewLabel ?? head.label,
    ready,
    steps,
    action: firstAction(steps),
  };
}

function runtimeFacts(
  version: string | undefined,
  command: string,
  origin: string | undefined,
): string[] {
  return [
    ...(version ? [`v${version.replace(/^v/, "")}`] : []),
    formatFilesystemPath(command),
    ...(origin ? [origin] : []),
  ];
}

function checkedFact(at: number | undefined, now: number): string[] {
  return at === undefined ? [] : [`checked ${acpRelativeTime(at, now)}`];
}

/* ----------------------------------------------------------------
   Claude Code
   ---------------------------------------------------------------- */

type ClaudeInstallation = BackendSummary["claude"];

const CLAUDE_METHOD_LABEL = {
  "api-key": "API key",
  gateway: "Gateway",
  external: "External provider",
  "claude-account": "Signed in",
} as const;

export function claudeSetupStatus(
  installation: ClaudeInstallation | undefined,
  options: { signingIn?: boolean } = {},
): HarnessSetupStatus {
  if (!installation) {
    return status(
      { label: "Not checked", tone: "muted", dot: "off" },
      [
        {
          id: "runtime",
          state: "unknown",
          label: "Not checked yet",
          action: "check",
        },
        WAITING_FOR_RUNTIME,
        readyWaiting(2),
      ],
    );
  }
  const executable = installation.executable;
  if (!executable) {
    return status(
      {
        label: "Not installed",
        tone: "muted",
        dot: "off",
        navChip: "not installed",
      },
      [
        {
          id: "runtime",
          state: "next",
          label: "Not installed",
          detail: "No Claude Code was found, and the copy bundled with PwrAgent could not start.",
          action: "install",
        },
        WAITING_FOR_RUNTIME,
        readyWaiting(2),
      ],
    );
  }
  const runtime: HarnessSetupStep = {
    id: "runtime",
    state: "done",
    label: "Found",
    facts: runtimeFacts(
      installation.version,
      executable,
      installation.source === "bundled" ? "bundled with PwrAgent" : "your install",
    ),
  };
  if (options.signingIn && installation.authStatus !== "signed-in") {
    return status(
      { label: "Signing in…", tone: "warn", dot: "off", reviewLabel: "Signing in" },
      [
        runtime,
        {
          id: "account",
          state: "working",
          label: "Waiting for the browser",
          detail: "Finish signing in to your Claude account in the browser. This updates when Claude Code reports the sign-in.",
        },
        readyWaiting(2),
      ],
    );
  }
  if (installation.authStatus === "session-expired") {
    return status(
      { label: "Sign-in expired", tone: "warn", dot: "warn", navChip: "sign in" },
      [
        runtime,
        {
          id: "account",
          state: "attention",
          label: "Sign-in expired",
          detail: "A Claude turn was refused because the session expired. Sign in again to keep using this account.",
          action: "sign-in-again",
        },
        readyWaiting(2),
      ],
    );
  }
  if (installation.authStatus === "sign-in-required") {
    return status(
      { label: "Sign-in required", tone: "warn", dot: "warn", navChip: "sign in" },
      [
        runtime,
        {
          id: "account",
          state: "next",
          label: "Not signed in",
          detail: "Sign in to your Claude account. Claude Code keeps this sign-in, so your terminal uses it too. It is separate from PwrAgent.",
          action: "sign-in",
        },
        readyWaiting(2),
      ],
    );
  }
  if (installation.authStatus !== "signed-in") {
    return status(
      { label: "Check failed", tone: "warn", dot: "warn", navChip: "check failed" },
      [
        runtime,
        {
          id: "account",
          state: "attention",
          label: "Couldn't check",
          ...(installation.message ? { detail: installation.message } : {}),
          action: "check",
        },
        readyWaiting(2),
      ],
    );
  }
  const method = CLAUDE_METHOD_LABEL[installation.authMethod ?? "claude-account"];
  return status(
    { label: method, tone: "ok", dot: "ok", reviewLabel: "Ready" },
    [
      runtime,
      {
        id: "account",
        state: "done",
        label: "Signed in",
        facts: [
          installation.authMethod === "gateway"
            ? installation.gatewayUrl ?? "LLM gateway"
            : installation.authMethod === "api-key"
              ? "API key"
              : installation.authMethod === "external"
                ? "external provider"
                : "Claude account",
        ],
        action: "manage-account",
      },
      {
        id: "ready",
        state: "done",
        label: "Ready",
        // Ready means the saved sign-in works, not that the plan has room.
        facts: ["sign-in checked; credits and usage limits are not"],
      },
    ],
  );
}

/* ----------------------------------------------------------------
   ACP agents (Gemini, Grok, Kimi, Qwen, Antigravity)
   ---------------------------------------------------------------- */

function acpOrigin(entry: AcpAgentSettingsEntry): string | undefined {
  if (entry.pwrAgentManagedRuntime) return "PwrAgent build";
  const active = entry.instances?.find((instance) => instance.command === entry.activeCommand);
  if (active?.pwrAgentBuild) return "PwrAgent build";
  if (active?.source === "override") return "your path";
  if (active?.source === "path") return "on PATH";
  if (active?.source === "fallback") return "install folder";
  return undefined;
}

export function acpSetupStatus(
  entry: AcpAgentSettingsEntry | undefined,
  options: { enabled: boolean; now?: number },
): HarnessSetupStatus {
  const now = options.now ?? Date.now();
  if (!options.enabled) {
    return status(
      { label: "Off", tone: "muted", dot: "off", navChip: "off", reviewLabel: "Turned off" },
      [
        {
          id: "enable",
          state: "next",
          label: "Off",
          detail: "Agents that are off are hidden from the model picker and are not checked.",
          action: "enable",
        },
        { id: "runtime", state: "waiting", label: "After step 1" },
        { id: "account", state: "waiting", label: "After step 2" },
        readyWaiting(3),
      ],
    );
  }
  if (!entry) {
    return status(
      { label: "Not checked", tone: "muted", dot: "off" },
      [
        { id: "runtime", state: "unknown", label: "Not checked yet", action: "check" },
        WAITING_FOR_RUNTIME,
        readyWaiting(2),
      ],
    );
  }
  if (!entry.installed) {
    if (entry.incompatibleInstances?.length) {
      return status(
        { label: "Legacy CLI found", tone: "warn", dot: "warn", navChip: "action required", reviewLabel: "Action required" },
        [
          {
            id: "runtime",
            state: "attention",
            label: "Only an unsupported older CLI is installed",
            detail: "PwrAgent never launches it. Install the current CLI, then check again.",
            action: "install",
          },
          WAITING_FOR_RUNTIME,
          readyWaiting(2),
        ],
      );
    }
    const timedOut = entry.rejectedInstances?.some((instance) => instance.reason === "probe-timed-out");
    if (timedOut || entry.installStatus === "install-failed") {
      const rejected = entry.rejectedInstances?.[0];
      return status(
        { label: "Check failed", tone: "warn", dot: "warn", navChip: "check failed" },
        [
          {
            id: "runtime",
            state: "attention",
            label: timedOut ? "Check timed out" : "Check failed",
            ...(rejected ? { facts: [formatFilesystemPath(rejected.command)] } : {}),
            detail: timedOut
              ? `${entry.name} was found but did not answer in time. A first launch after an update can be slow.`
              : entry.lastDiscoveryError ?? entry.lastError ?? `PwrAgent could not check ${entry.name}.`,
            action: "check",
          },
          WAITING_FOR_RUNTIME,
          readyWaiting(2),
        ],
      );
    }
    if (entry.rejectedInstances?.length) {
      const rejected = entry.rejectedInstances[0]!;
      return status(
        { label: "Found but unusable", tone: "warn", dot: "warn", navChip: "action required", reviewLabel: "Action required" },
        [
          {
            id: "runtime",
            state: "attention",
            label: "Found but unusable",
            facts: [formatFilesystemPath(rejected.command)],
            detail: `This ${entry.name} did not pass PwrAgent's ACP check. Install a supported version, or choose another path.`,
            action: "install",
          },
          WAITING_FOR_RUNTIME,
          readyWaiting(2),
        ],
      );
    }
    return status(
      { label: "Not installed", tone: "muted", dot: "off" },
      [
        {
          id: "runtime",
          state: "next",
          label: "Not found",
          detail: `PwrAgent checked PATH and the usual install folders. Install ${entry.name}, or point PwrAgent at a copy it missed.`,
          action: "install",
        },
        WAITING_FOR_RUNTIME,
        readyWaiting(2),
      ],
    );
  }

  const runtime: HarnessSetupStep = {
    id: "runtime",
    state: "done",
    label: "Found",
    facts: entry.activeCommand
      ? runtimeFacts(entry.version, entry.activeCommand, acpOrigin(entry))
      : entry.version ? [`v${entry.version}`] : [],
  };
  if (grokSignInRequired(entry)) {
    return status(
      { label: "Sign-in required", tone: "warn", dot: "warn", navChip: "sign in" },
      [
        runtime,
        {
          id: "account",
          state: "next",
          label: "Sign in from a terminal",
          detail: `${entry.name} signs in to your xAI account from its own CLI. Run this in a terminal, finish in the browser it opens, then check again.`,
          action: "terminal-sign-in",
        },
        readyWaiting(2),
      ],
    );
  }
  if (entry.unavailableReason) {
    return status(
      { label: "Action required", tone: "warn", dot: "warn", navChip: "action required" },
      [
        runtime,
        {
          id: "account",
          state: "attention",
          label: "Action required",
          detail: entry.unavailableReason,
          action: entry.registryId === "antigravity" ? "manage-account" : "check",
        },
        readyWaiting(2),
      ],
    );
  }
  if (entry.lastDiscoveryError) {
    return status(
      { label: "Check failed", tone: "warn", dot: "warn", navChip: "check failed" },
      [
        runtime,
        // Unconfirmed until the check below passes; the check is the step to
        // take, so this one waits rather than becoming current.
        {
          id: "account",
          state: "waiting",
          label: "Not confirmed",
        },
        {
          id: "ready",
          state: "attention",
          label: "Check failed",
          detail: entry.lastDiscoveryError,
          action: "check",
        },
      ],
    );
  }
  if (entry.lastDiscoveredAt === undefined) {
    return status(
      { label: "Not checked", tone: "muted", dot: "off" },
      [
        runtime,
        {
          id: "account",
          state: "unknown",
          label: "Not checked yet",
          detail: `Check ${entry.name} to confirm it starts and accepts your account.`,
          action: "check",
        },
        readyWaiting(2),
      ],
    );
  }
  return status(
    { label: "Ready", tone: "ok", dot: "ok" },
    [
      runtime,
      { id: "account", state: "done", label: "Accepted", facts: ["models discovered at last check"] },
      {
        id: "ready",
        state: "done",
        label: "Ready",
        facts: checkedFact(entry.lastDiscoveredAt, now),
      },
    ],
  );
}

/* ----------------------------------------------------------------
   Codex
   ---------------------------------------------------------------- */

/** What a sign-in started from this screen says right now. Newer than the
 *  snapshot, which only learns about it on the next settings read. */
export type CodexLoginObservation =
  | { kind: "idle" }
  | { kind: "signed-out"; detail?: string }
  | { kind: "starting" }
  | { kind: "waiting"; detail?: string }
  | { kind: "checking" }
  | { kind: "ok"; email?: string; planType?: string }
  | { kind: "error"; detail: string };

type CodexSnapshot = DesktopSettingsSnapshot["models"]["codex"];

const CODEX_SOURCE_ORIGIN = {
  path: "on PATH",
  application: "app install",
  config: "your path",
  env: "environment path",
} as const;

export function codexSetupStatus(params: {
  codex: CodexSnapshot;
  backend?: BackendSummary;
  /** Live progress of PwrAgent's Codex build download, when one runs. */
  managedProgress?: ManagedRuntimeProgress;
  login?: CodexLoginObservation;
}): HarnessSetupStatus {
  const { codex, backend, managedProgress } = params;
  const candidates = codex.discovery.candidates;
  // Discovery names its pick; a candidate's own flag is the fallback.
  const selectedCommand = codex.discovery.selectedCommand;
  const selected = candidates.find((candidate) => (selectedCommand
    ? candidate.command === selectedCommand
    : candidate.selected) && isValidatedDiscoveryCandidate(candidate));
  const savedPath = codex.path.value.trim();
  // A release check alone installs nothing, so it does not read as one.
  const installing = managedProgress !== undefined
    && managedProgress.phase !== "checking"
    && managedProgress.phase !== "ready"
    && managedProgress.phase !== "failed"
    && managedProgress.phase !== "idle";

  if (!selected) {
    if (installing) {
      return status(
        { label: "Installing", tone: "warn", dot: "off", reviewLabel: "Installing" },
        [
          {
            id: "runtime",
            state: "working",
            label: "Installing PwrAgent's build",
            detail: "PwrAgent is downloading and verifying its Codex build.",
          },
          WAITING_FOR_RUNTIME,
          readyWaiting(2),
        ],
      );
    }
    const pinned = savedPath !== ""
      ? candidates.find((candidate) => candidate.command === savedPath
        && (candidate.source === "config" || candidate.source === "env"))
      : undefined;
    if (pinned && !isValidatedDiscoveryCandidate(pinned)) {
      const reason = pinned.failureReason ?? pinned.versionFailureReason;
      return status(
        { label: "Path doesn't work", tone: "err", dot: "warn", navChip: "fix path", reviewLabel: "Action required" },
        [
          {
            id: "runtime",
            state: "attention",
            label: "Your path doesn't work",
            facts: [
              formatFilesystemPath(pinned.command),
              ...(pinned.version ? [`v${pinned.version}`] : []),
              describeCommandDiscoveryFailure(reason) ?? "Not executable",
            ],
            detail: "New threads can't start until this is fixed. Your other Codex settings are kept.",
            action: "fix-path",
          },
          WAITING_FOR_RUNTIME,
          readyWaiting(2),
        ],
      );
    }
    if (codex.discovery.error) {
      return status(
        { label: "Check failed", tone: "warn", dot: "warn", navChip: "check failed" },
        [
          {
            id: "runtime",
            state: "attention",
            label: "Check failed",
            detail: codex.discovery.error,
            action: "check",
          },
          WAITING_FOR_RUNTIME,
          readyWaiting(2),
        ],
      );
    }
    const managedFailed = managedProgress?.phase === "failed" ? managedProgress.error : undefined;
    const rejected = candidates.filter((candidate) => !isValidatedDiscoveryCandidate(candidate));
    return status(
      managedFailed
        ? { label: "Install failed", tone: "warn", dot: "warn", navChip: "install failed", reviewLabel: "Action required" }
        : { label: "Not found", tone: "muted", dot: "off", reviewLabel: "Not installed" },
      [
        {
          id: "runtime",
          state: managedFailed ? "attention" : "next",
          label: managedFailed ? "Install failed" : "Not found",
          detail: managedFailed
            ?? (rejected.length > 0
              ? `PwrAgent found ${rejected.length} Codex ${rejected.length === 1 ? "copy" : "copies"} it can't use. Install Codex, or choose a path.`
              : "PwrAgent checked PATH and the usual install folders. Install Codex, or point PwrAgent at a copy it missed."),
          action: "install",
        },
        WAITING_FOR_RUNTIME,
        readyWaiting(2),
      ],
    );
  }

  const runtime: HarnessSetupStep = {
    id: "runtime",
    state: "done",
    label: "Found",
    facts: runtimeFacts(
      selected.version,
      selected.command,
      backend?.runtimeBuild?.channel === "pwragent"
        ? "PwrAgent build"
        : CODEX_SOURCE_ORIGIN[selected.source],
    ),
  };

  const profiles = codex.profiles.profiles;
  const profile = profiles.find((candidate) => candidate.selected)
    ?? profiles.find((candidate) => candidate.name === "");
  const profileName = profile
    ? (profile.name === "" ? "System default" : profile.displayName)
    : undefined;
  const login = params.login ?? { kind: "idle" };
  let account: HarnessSetupStep;
  if (login.kind === "starting" || login.kind === "waiting" || login.kind === "checking") {
    account = {
      id: "account",
      state: "working",
      label: login.kind === "checking" ? "Checking" : "Waiting for the browser",
      detail: login.kind === "starting"
        ? "Starting codex login…"
        : "Finish signing in in your browser, then come back. PwrAgent checks again when this window regains focus.",
      action: "sign-in",
    };
  } else if (login.kind === "error") {
    account = {
      id: "account",
      state: "attention",
      label: "Sign-in didn't finish",
      detail: login.detail,
      action: "sign-in",
    };
  } else if (login.kind === "signed-out") {
    account = {
      id: "account",
      state: "next",
      label: "Not signed in",
      detail: "Sign in to your OpenAI account (ChatGPT). This is Codex's own sign-in. It is separate from PwrAgent.",
      action: "sign-in",
    };
  } else if (login.kind === "ok") {
    account = {
      id: "account",
      state: "done",
      label: "Signed in",
      facts: [login.email, login.planType, profileName].filter((fact): fact is string => Boolean(fact)),
      action: "manage-account",
    };
  } else if (profile && !profile.exists) {
    account = {
      id: "account",
      state: "attention",
      label: "Profile folder missing",
      facts: [formatFilesystemPath(profile.codexHome)],
      detail: "The selected auth profile's folder is gone. Choose another profile, or create it again.",
      action: "manage-account",
    };
  } else if (profile?.authenticationRequired && profile.hasAuthFile) {
    account = {
      id: "account",
      state: "attention",
      label: "Sign-in expired",
      facts: [profile.accountEmail, profileName].filter((fact): fact is string => Boolean(fact)),
      detail: "Codex refused this account as signed out. Sign in again, or switch the auth profile.",
      action: "sign-in-again",
    };
  } else if (!profile?.hasAuthFile) {
    account = {
      id: "account",
      state: "next",
      label: "Not signed in",
      detail: "Sign in to your OpenAI account (ChatGPT). This is Codex's own sign-in. It is separate from PwrAgent.",
      action: "sign-in",
    };
  } else {
    account = {
      id: "account",
      state: "done",
      label: "Saved sign-in",
      facts: [profile.accountEmail, profileName].filter((fact): fact is string => Boolean(fact)),
      action: "manage-account",
    };
  }

  let ready: HarnessSetupStep;
  if (account.state !== "done") {
    ready = readyWaiting(2);
  } else if (backend && !backend.available && !backend.discoveryPending && backend.unavailableReason) {
    ready = {
      id: "ready",
      state: "attention",
      label: "Check failed",
      detail: backend.unavailableReason,
      action: "check",
    };
  } else {
    ready = { id: "ready", state: "done", label: "Ready" };
  }

  const steps = [runtime, account, ready];
  if (account.state === "working") {
    return status({ label: "Signing in…", tone: "warn", dot: "off", reviewLabel: "Signing in" }, steps);
  }
  if (account.state === "attention" && account.label === "Sign-in expired") {
    return status({ label: "Sign-in expired", tone: "warn", dot: "warn", navChip: "sign in" }, steps);
  }
  if (account.state === "attention" && account.label === "Profile folder missing") {
    return status({ label: "Action required", tone: "warn", dot: "warn", navChip: "action required" }, steps);
  }
  if (account.state === "attention") {
    return status({ label: "Sign-in didn't finish", tone: "warn", dot: "warn", navChip: "sign in", reviewLabel: "Sign-in required" }, steps);
  }
  if (account.state === "next") {
    return status({ label: "Sign-in required", tone: "warn", dot: "warn", navChip: "sign in" }, steps);
  }
  if (ready.state === "attention") {
    return status({ label: "Check failed", tone: "warn", dot: "warn", navChip: "check failed" }, steps);
  }
  return status({ label: "Ready", tone: "ok", dot: "ok" }, steps);
}
