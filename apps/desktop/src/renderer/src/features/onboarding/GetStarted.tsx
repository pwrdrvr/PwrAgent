import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AcpAgentSettingsEntry, BackendSummary } from "@pwragent/shared/contracts/backend";
import type {
  DesktopBootInfo,
  DesktopSettingsConfigPatch,
  DesktopSettingsSnapshot,
} from "@pwragent/shared/contracts/settings";
import type { DesktopApi } from "../../lib/desktop-api";
import { BACKEND_SUMMARIES_REFRESH_EVENT } from "../../lib/useBackendSummaries";
import { useModalDialog } from "../../lib/useModalDialog";
import type { ClaudeSignInControls } from "../notifications/useClaudeSignIn";
import type { DesktopSettingsState } from "../settings/useDesktopSettings";
import {
  CheckIcon,
  CloseIcon,
  GrokIcon,
  OpenAIIcon,
  TerminalIcon,
} from "../../icons";
import {
  acpAgentState,
  canStartWithAgents,
  claudeAgentState,
  codexAgentState,
  getStartedAgentAction,
  selectedCodexCandidate,
  type CodexSignInState,
  type GetStartedAgentState,
} from "./get-started-agents";
import { provisionPairedProfiles } from "./provisionPairedProfiles";

/**
 * First run, on one page: every agent on this computer with the one step
 * each still needs, then Start. Thread presentation, extra Codex profiles
 * and messaging are not asked here; they live in Settings, so nothing
 * optional stands between a new install and its first thread.
 *
 * A fresh install runs in the throwaway bootstrap profile. Start creates
 * the real profile (`default`, or the name the launch asked for), carries
 * the bootstrap settings over, opens PwrAgent in it, and quits this
 * instance. The new window lands on the composer by itself. In an existing
 * profile (Help → Replay Onboarding, or Run setup from the no-provider
 * notice) Start just closes the page.
 */
export function GetStarted(props: {
  /** Help → Replay Onboarding or Run setup: never touches profiles. */
  isReplay: boolean;
  bootInfo: DesktopBootInfo | null;
  settings: DesktopSettingsState;
  desktopApi?: DesktopApi;
  claudeSignIn?: ClaudeSignInControls;
  /** Start in an existing profile. */
  onComplete: () => Promise<void> | void;
  /** Closed without starting. `persistCompleted` marks first run done. */
  onDismiss: (persistCompleted: boolean) => void;
}) {
  const requestedName = props.bootInfo?.decisionKind === "missing-named-profile" && !props.isReplay
    ? props.bootInfo.requestedProfileName?.trim() || undefined
    : undefined;
  const inBootstrapMode = props.bootInfo?.mode === "bootstrap";
  const [confirmingProfile, setConfirmingProfile] = useState(Boolean(requestedName));
  // A profile the launch named gets its own Codex login by default, as it
  // always has. A plain first run shares this computer's.
  const [separateLogin, setSeparateLogin] = useState(Boolean(requestedName));
  const [submitting, setSubmitting] = useState(false);
  const [dismissModalOpen, setDismissModalOpen] = useState(false);

  const handleClose = useCallback((): void => {
    if (submitting) return;
    if (inBootstrapMode && !props.isReplay) {
      setDismissModalOpen(true);
      return;
    }
    props.onDismiss(false);
  }, [inBootstrapMode, props, submitting]);

  const dialogRef = useModalDialog({
    onClose: handleClose,
    initialFocus: "dialog",
  });

  const agents = useGetStartedAgents({
    settings: props.settings,
    desktopApi: props.desktopApi,
    separateLogin,
  });

  const provisionAndOpen = useCallback(
    async (useSeparateLogin: boolean): Promise<void> => {
      const api = props.desktopApi;
      const profileName = bootstrapProvisionProfileName(props.bootInfo);
      if (!api?.createPwrAgentProfile) {
        props.onDismiss(false);
        return;
      }
      await props.settings.writeConfig({
        general: { codexProfileModel: useSeparateLogin ? "isolated" : "shared" },
      } satisfies DesktopSettingsConfigPatch);
      let target: string | undefined = profileName;
      if (useSeparateLogin) {
        // A PwrAgent profile paired with a Codex login of the same name.
        // Its Codex sign-in happens in the new window, under Settings →
        // Profiles, so this page never signs in the wrong account.
        target = (await provisionPairedProfiles(api, [profileName]))[0];
      } else {
        // No Codex pairing means this computer's own Codex login.
        await api.createPwrAgentProfile({
          profile: profileName,
          seedOnboardingCompleted: true,
        });
      }
      if (!target) return;
      if (api.graduateBootstrapConfigToProfile) {
        try {
          await api.graduateBootstrapConfigToProfile({ targetProfile: target });
        } catch (caught) {
          console.warn(`Get started: graduateBootstrapConfigToProfile failed for "${target}"`, caught);
        }
      }
      const handedOff = await openProfileAndQuitBootstrap(api, target, inBootstrapMode);
      // Not handed off: the new window never reported in, or could not
      // open. The profile exists, so a second Start would only fail; close
      // this page and leave the bootstrap window up as the fallback.
      if (!handedOff) await props.onComplete();
    },
    [inBootstrapMode, props],
  );

  const start = useCallback(
    async (options?: { withoutAgent?: boolean }): Promise<void> => {
      if (submitting) return;
      setSubmitting(true);
      try {
        if (props.isReplay || !inBootstrapMode) {
          if (options?.withoutAgent && !props.isReplay) {
            props.onDismiss(true);
            return;
          }
          await props.onComplete();
          return;
        }
        await provisionAndOpen(separateLogin);
      } catch (caught) {
        console.warn("Get started: Start failed", caught);
      } finally {
        setSubmitting(false);
        setDismissModalOpen(false);
      }
    },
    [inBootstrapMode, props, provisionAndOpen, separateLogin, submitting],
  );

  const exitApp = useCallback((): void => {
    if (props.desktopApi?.quitApp) {
      void props.desktopApi.quitApp();
    } else {
      props.onDismiss(false);
    }
  }, [props]);

  const startReady = canStartWithAgents(agents.rows.map((row) => row.state));
  const eyebrow = props.isReplay ? "Replay" : requestedName ? "Set up profile" : "Welcome";
  const crumb = confirmingProfile ? "Confirm new profile" : "Get started";

  return (
    <div
      ref={dialogRef}
      className="get-started-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Get started"
      tabIndex={-1}
    >
      <div className="get-started-overlay__scrim" />
      <div className="get-started">
        <header className="get-started__titlebar">
          <span className="get-started__eyebrow">{eyebrow}</span>
          <span className="get-started__sep" aria-hidden="true">/</span>
          <span className="get-started__crumb">{crumb}</span>
          <span className="get-started__spacer" />
          <button
            type="button"
            className="get-started__close"
            aria-label="Close setup"
            onClick={handleClose}
          >
            <CloseIcon />
          </button>
        </header>
        {confirmingProfile && requestedName ? (
          <ConfirmProfile
            name={requestedName}
            submitting={submitting}
            onContinue={() => setConfirmingProfile(false)}
            onQuit={exitApp}
          />
        ) : (
          <>
            <div className="get-started__body">
              <header className="get-started__head">
                <h1 className="get-started__title">
                  {startReady ? "Your agents are ready." : "Set up an agent to start."}
                </h1>
                <p className="get-started__sub">
                  PwrAgent runs the coding agents already on this computer.
                  Each provider bills you for its own usage. PwrAgent has no
                  account of its own and collects no usage data.
                </p>
              </header>
              {requestedName ? (
                <CodexLoginChoice
                  profileName={requestedName}
                  separate={separateLogin}
                  onChange={setSeparateLogin}
                />
              ) : null}
              <AgentList
                agents={agents}
                desktopApi={props.desktopApi}
                claudeSignIn={props.claudeSignIn}
              />
              <p className="get-started__fine">
                Thread layout, more profiles, and messaging are in Settings
                whenever you want them.
              </p>
              <p className="get-started__fine">{TRADEMARK_NOTE}</p>
            </div>
            <footer className="get-started__footer">
              <button
                type="button"
                className="get-started__btn get-started__btn--link"
                disabled={submitting}
                onClick={() => void start({ withoutAgent: true })}
              >
                {props.isReplay ? "Close" : "Start without an agent"}
              </button>
              <span className="get-started__spacer" />
              {startReady ? null : (
                <span className="get-started__hint" id="get-started-start-hint">
                  Set up one agent to start.
                </span>
              )}
              <button
                type="button"
                className="get-started__btn get-started__btn--primary"
                disabled={!startReady || submitting}
                aria-describedby={startReady ? undefined : "get-started-start-hint"}
                onClick={() => void start()}
              >
                {submitting ? "Starting…" : props.isReplay ? "Done" : "Start"}
              </button>
            </footer>
          </>
        )}
        {dismissModalOpen ? (
          <DismissConfirmModal
            profileName={requestedName}
            separateLogin={separateLogin}
            submitting={submitting}
            onCancel={() => setDismissModalOpen(false)}
            onContinueWithoutAgent={() => void start({ withoutAgent: true })}
            onExit={exitApp}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * The profile name a bootstrap Start provisions. A profile pinned with
 * `PWRAGENT_PROFILE` or `--profile` is resolved first on every launch, so
 * the profile must carry that exact name or the next boot looks for it
 * again and reopens this page. With no name asked for, it is `default`.
 */
export function bootstrapProvisionProfileName(
  bootInfo: DesktopBootInfo | null | undefined,
): string {
  const requested = bootInfo?.decisionKind === "missing-named-profile"
    ? bootInfo.requestedProfileName?.trim()
    : undefined;
  return requested || "default";
}

/**
 * Opens the new profile's window, then quits this bootstrap instance once
 * that window reports it is alive. Leaving the bootstrap open on a timeout
 * keeps a window on screen if the new one never comes up.
 *
 * Resolves `true` once this instance has asked to quit, so the caller
 * leaves the page up for the moment before the window closes.
 */
async function openProfileAndQuitBootstrap(
  api: DesktopApi,
  targetProfile: string,
  inBootstrapMode: boolean,
): Promise<boolean> {
  if (!api.openPwrAgentProfile) return false;
  // Messaging adapters hold exclusive upstream connections; release them
  // before another process opens the same profile.
  if (api.shutdownMessagingRuntime) {
    try {
      await api.shutdownMessagingRuntime();
    } catch (caught) {
      console.warn("Get started: shutdownMessagingRuntime failed before opening the profile", caught);
    }
  }
  // Dev mode cannot open a second Electron instance against electron-vite's
  // single dev server. The profile is set up and is now the default, so
  // exit and let the next `pnpm dev` open it.
  if (import.meta.env.DEV && inBootstrapMode) {
    console.info(
      `Get started: profile "${targetProfile}" is ready. Dev mode can't open a second app `
        + `instance, so PwrAgent will exit now. Relaunch with \`pnpm dev\` to open it.`,
    );
    if (!api.quitApp) return false;
    try {
      await api.quitApp();
      return true;
    } catch (caught) {
      console.warn("Get started: quitApp after setup (dev) failed", caught);
      return false;
    }
  }
  try {
    await api.openPwrAgentProfile({ profile: targetProfile });
  } catch (caught) {
    console.warn(`Get started: failed to open "${targetProfile}"`, caught);
    return false;
  }
  if (!inBootstrapMode) return false;
  if (api.waitForProfileAlive) {
    try {
      const result = await api.waitForProfileAlive({ profile: targetProfile, timeoutMs: 10_000 });
      if (!result.alive) {
        console.warn(`Get started: "${targetProfile}" didn't report alive in time; keeping this window open`);
        return false;
      }
    } catch (caught) {
      console.warn("Get started: waitForProfileAlive failed; keeping this window open", caught);
      return false;
    }
  }
  // The new window still has to fetch and paint its renderer after its
  // heartbeat appears. In dev that comes from Vite, which quits with us.
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  if (!api.quitApp) return false;
  try {
    await api.quitApp();
    return true;
  } catch (caught) {
    console.warn("Get started: quitApp after opening the profile failed", caught);
    return false;
  }
}

/* ----------------------------------------------------------------
   Agents
   ---------------------------------------------------------------- */

type AcpAgentId = "gemini" | "kimi" | "qwen" | "grok";
type AgentId = "codex" | "claude" | AcpAgentId;
type DesktopPlatform = "darwin" | "win32" | "linux";
type InstallCommand = { label: string; command: string };

type AgentDefinition = {
  id: AgentId;
  name: string;
  /** A vendor mark only where the vendor's terms allow it; see brand-assets.md. */
  mark: "codex" | "grok" | "cli";
  docsUrl: string;
  installCommands: Record<DesktopPlatform, ReadonlyArray<InstallCommand>>;
  platformNotes?: Partial<Record<DesktopPlatform, string>>;
  /** Shown first whatever its state. Other agents wait behind More agents
   *  until they are installed. */
  primary?: boolean;
};

const AGENTS: readonly AgentDefinition[] = [
  {
    id: "codex",
    name: "Codex",
    mark: "codex",
    primary: true,
    docsUrl: "https://learn.chatgpt.com/docs/codex/cli#getting-started",
    installCommands: {
      darwin: [
        { label: "Recommended", command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh" },
        { label: "Homebrew", command: "brew install --cask codex" },
        { label: "npm", command: "npm install -g @openai/codex" },
      ],
      linux: [
        { label: "Recommended", command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh" },
        { label: "npm", command: "npm install -g @openai/codex" },
      ],
      win32: [
        {
          label: "PowerShell (recommended)",
          command: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
        },
        { label: "npm", command: "npm install -g @openai/codex" },
      ],
    },
  },
  {
    id: "claude",
    name: "Claude Code",
    mark: "cli",
    primary: true,
    docsUrl: "https://code.claude.com/docs/en/setup",
    installCommands: { darwin: [], linux: [], win32: [] },
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    mark: "cli",
    docsUrl: "https://geminicli.com/docs/get-started/installation/",
    installCommands: {
      darwin: [
        { label: "Homebrew", command: "brew install gemini-cli" },
        { label: "npm", command: "npm install -g @google/gemini-cli" },
      ],
      linux: [{ label: "npm", command: "npm install -g @google/gemini-cli" }],
      win32: [{ label: "npm", command: "npm install -g @google/gemini-cli" }],
    },
  },
  {
    id: "kimi",
    name: "Kimi Code",
    mark: "cli",
    docsUrl: "https://moonshotai.github.io/kimi-code/en/guides/getting-started",
    installCommands: {
      darwin: [
        { label: "Recommended", command: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash" },
        { label: "npm (Node.js 22.19+)", command: "npm install -g @moonshot-ai/kimi-code" },
      ],
      linux: [
        { label: "Recommended", command: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash" },
        { label: "npm (Node.js 22.19+)", command: "npm install -g @moonshot-ai/kimi-code" },
      ],
      win32: [
        { label: "PowerShell (recommended)", command: "irm https://code.kimi.com/kimi-code/install.ps1 | iex" },
        { label: "npm (Node.js 22.19+)", command: "npm install -g @moonshot-ai/kimi-code" },
      ],
    },
    platformNotes: {
      win32: "Install Git for Windows before first launch; Kimi uses its bundled Git Bash.",
    },
  },
  {
    id: "qwen",
    name: "Qwen Code",
    mark: "cli",
    docsUrl: "https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/",
    installCommands: {
      darwin: [
        {
          label: "Recommended",
          command:
            "curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash",
        },
        { label: "Homebrew", command: "brew install qwen-code" },
        { label: "npm (Node.js 22+)", command: "npm install -g @qwen-code/qwen-code@latest" },
      ],
      linux: [
        {
          label: "Recommended",
          command:
            "curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash",
        },
        { label: "Homebrew", command: "brew install qwen-code" },
        { label: "npm (Node.js 22+)", command: "npm install -g @qwen-code/qwen-code@latest" },
      ],
      win32: [
        {
          label: "PowerShell (recommended)",
          command:
            "irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex",
        },
        { label: "npm (Node.js 22+)", command: "npm install -g @qwen-code/qwen-code@latest" },
      ],
    },
    platformNotes: {
      darwin: "Qwen OAuth has ended; choose a provider from /auth after launch.",
      linux: "Qwen OAuth has ended; choose a provider from /auth after launch.",
      win32: "Restart the terminal after install. Qwen OAuth has ended; use /auth after launch.",
    },
  },
  {
    id: "grok",
    name: "Grok Build",
    mark: "grok",
    docsUrl: "https://docs.x.ai/build/overview",
    installCommands: {
      darwin: [{ label: "Recommended", command: "curl -fsSL https://x.ai/cli/install.sh | bash" }],
      linux: [{ label: "Recommended", command: "curl -fsSL https://x.ai/cli/install.sh | bash" }],
      win32: [{ label: "PowerShell", command: "irm https://x.ai/cli/install.ps1 | iex" }],
    },
  },
];

const TRADEMARK_NOTE =
  "OpenAI, Codex, and the OpenAI logo are trademarks of OpenAI. Grok and the Grok logo are "
  + "trademarks of SpaceXAI, formerly xAI. Claude is a trademark of Anthropic. Gemini is a "
  + "trademark of Google LLC. Kimi is a trademark of Moonshot AI. Qwen is a trademark of Alibaba "
  + "Cloud. PwrAgent is independently developed and is not affiliated with, endorsed by, or "
  + "sponsored by any of them.";

const CLAUDE_SIGN_IN_COMMAND = "claude auth login";

type AgentRow = { definition: AgentDefinition; state: GetStartedAgentState };

type AgentsModel = {
  rows: AgentRow[];
  refreshing: boolean;
  error?: string;
  refresh: () => Promise<void>;
  turnOn: (id: AcpAgentId) => Promise<void>;
  codexSignIn: CodexSignInState;
  startCodexSignIn: () => Promise<void>;
  cancelCodexSignIn: () => void;
  /** The user opened an install or sign-in step outside this window. */
  noteSetupStep: () => void;
};

function desktopPlatform(platform?: string): DesktopPlatform {
  if (platform === "win32" || platform === "linux") return platform;
  return "darwin";
}

function acpEnabled(snapshot: DesktopSettingsSnapshot | undefined, id: AcpAgentId): boolean {
  const agents = snapshot?.acpAgents as Record<string, { enabled?: boolean } | undefined> | undefined;
  return agents?.[id]?.enabled !== false;
}

/**
 * Discovery and sign-in for every row. Discovery runs once as the page
 * opens, again on Check again, and again when the window regains focus
 * after an install or a browser sign-in. Nothing installs or signs in
 * until its button is clicked.
 */
function useGetStartedAgents(params: {
  settings: DesktopSettingsState;
  desktopApi?: DesktopApi;
  separateLogin: boolean;
}): AgentsModel {
  const { settings, desktopApi, separateLogin } = params;
  // Read here, not from the app's backend summaries, which first run does
  // not load. Claude Code's row is drawn from it.
  const [backends, setBackends] = useState<readonly BackendSummary[]>();
  const [acpEntries, setAcpEntries] = useState<AcpAgentSettingsEntry[]>();
  const [refreshing, setRefreshing] = useState(true);
  const [error, setError] = useState<string>();
  const [optimisticEnabled, setOptimisticEnabled] = useState<Partial<Record<AcpAgentId, boolean>>>({});
  const [codexSignIn, setCodexSignIn] = useState<CodexSignInState>({ kind: "unknown" });
  const refreshingRef = useRef(false);
  const apiRef = useRef(desktopApi);
  apiRef.current = desktopApi;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const checkCodexSignIn = useCallback(async (): Promise<void> => {
    const api = apiRef.current;
    if (!api?.checkCodexAuthProfileStatus) {
      // An older bridge cannot say; an installed Codex is then the best
      // evidence available.
      setCodexSignIn({ kind: "signed-in" });
      return;
    }
    // A sign-in still open in the browser, or one the user cancelled, keeps
    // its row until a check finds the login; a recheck says nothing new.
    const keep = (current: CodexSignInState): boolean => current.kind === "waiting"
      || (current.kind === "signed-out" && current.cancelled === true);
    setCodexSignIn((current) => keep(current) ? current : { kind: "checking" });
    try {
      const result = await api.checkCodexAuthProfileStatus({ profile: "" });
      setCodexSignIn((current) => result.authenticated
        ? { kind: "signed-in", email: result.email, planType: result.planType }
        : keep(current)
          ? current
          : { kind: "signed-out", detail: result.detail });
    } catch (caught) {
      setCodexSignIn({ kind: "error", detail: caught instanceof Error ? caught.message : String(caught) });
    }
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    setError(undefined);
    const api = apiRef.current;
    try {
      const [codexResult, acpResult, backendsResult] = await Promise.allSettled([
        api?.refreshCodexDiscovery?.({ discoveryIntent: "setup-user-action" }),
        api?.listAcpAgents?.({
          discoveryIntent: "setup-user-action",
          refresh: true,
          probeCapabilities: false,
        }),
        // Claude Code's row comes from this summary, and the summary only
        // knows the CLI once Claude discovery has run. PwrAgent ships the
        // CLI, so a summary read before that would call it not installed.
        api?.listBackends?.({
          includeUnavailable: true,
          refreshModels: "claude",
          discoveryIntent: "setup-user-action",
        }),
      ]);
      const backendsValue = backendsResult.status === "fulfilled" ? backendsResult.value : undefined;
      setBackends((current) => backendsValue?.backends ?? current ?? []);
      const currentSettings = settingsRef.current;
      if (codexResult.status === "fulfilled" && codexResult.value && currentSettings.applySnapshot) {
        currentSettings.applySnapshot(codexResult.value.snapshot);
      } else {
        await currentSettings.refresh();
      }
      const errors: string[] = [];
      if (codexResult.status === "rejected") errors.push(String(codexResult.reason));
      if (acpResult.status === "fulfilled") {
        setAcpEntries(acpResult.value?.entries ?? []);
        if (acpResult.value?.error) errors.push(acpResult.value.error);
      } else {
        setAcpEntries((current) => current ?? []);
        errors.push(String(acpResult.reason));
      }
      if (errors.length > 0) setError(errors.join(" "));
      window.dispatchEvent(new Event(BACKEND_SUMMARIES_REFRESH_EVENT));
      await checkCodexSignIn();
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [checkCodexSignIn]);

  const initialRefreshStarted = useRef(false);
  useEffect(() => {
    if (initialRefreshStarted.current) return;
    initialRefreshStarted.current = true;
    void refresh();
  }, [refresh]);

  // Coming back to the window is the moment after an install or a browser
  // sign-in. Discovery starts every agent's CLI, so it runs only while no
  // agent is ready yet, or after the user opened one of those steps. An
  // uninstalled agent nobody asked about is not a reason to recheck.
  const recheckOnFocusRef = useRef(false);
  const setupStepOpenedRef = useRef(false);
  const noteSetupStep = useCallback((): void => {
    setupStepOpenedRef.current = true;
  }, []);
  useEffect(() => {
    if (!desktopApi?.onWindowFocus) return undefined;
    return desktopApi.onWindowFocus(() => {
      // The setup-step flag is read here, not folded in at render: opening
      // a row's install step re-renders only that row.
      if (recheckOnFocusRef.current || setupStepOpenedRef.current) void refresh();
    });
  }, [desktopApi, refresh]);

  const startCodexSignIn = useCallback(async (): Promise<void> => {
    const api = apiRef.current;
    if (!api?.startCodexAuthProfileLogin) return;
    setupStepOpenedRef.current = true;
    setCodexSignIn({ kind: "starting" });
    try {
      // This computer's own login: the empty profile is `~/.codex/`.
      const result = await api.startCodexAuthProfileLogin({ profile: "" });
      if (result.authenticated) {
        await checkCodexSignIn();
        return;
      }
      setCodexSignIn({ kind: "waiting", url: result.loginUrl });
    } catch (caught) {
      setCodexSignIn({ kind: "error", detail: caught instanceof Error ? caught.message : String(caught) });
    }
  }, [checkCodexSignIn]);

  const cancelCodexSignIn = useCallback((): void => {
    setCodexSignIn({ kind: "signed-out", detail: "Sign-in didn't finish. Nothing changed.", cancelled: true });
  }, []);

  const turnOn = useCallback(async (id: AcpAgentId): Promise<void> => {
    setError(undefined);
    const saved = await settingsRef.current.writeConfig({
      acpAgents: { [id]: { enabled: true } } as NonNullable<DesktopSettingsConfigPatch["acpAgents"]>,
    });
    if (!saved) return;
    setOptimisticEnabled((current) => ({ ...current, [id]: true }));
    window.dispatchEvent(new Event(BACKEND_SUMMARIES_REFRESH_EVENT));
  }, []);

  const snapshot = settings.snapshot;
  const rows = useMemo((): AgentRow[] => AGENTS.map((definition) => {
    let state: GetStartedAgentState;
    if (definition.id === "codex") {
      state = codexAgentState({
        snapshot,
        discovering: refreshing && !selectedCodexCandidate(snapshot),
        signIn: codexSignIn,
        separateLogin,
      });
    } else if (definition.id === "claude") {
      state = claudeAgentState(
        backends?.find((backend) => backend.kind === "claude"),
        backends !== undefined,
      );
    } else {
      const id = definition.id;
      state = acpAgentState({
        entry: acpEntries?.find((entry) => entry.registryId === id),
        entriesLoaded: acpEntries !== undefined,
        enabled: optimisticEnabled[id] ?? acpEnabled(snapshot, id),
      });
    }
    return { definition, state };
  }), [acpEntries, backends, codexSignIn, optimisticEnabled, refreshing, separateLogin, snapshot]);

  recheckOnFocusRef.current = codexSignIn.kind === "waiting"
    || !canStartWithAgents(rows.map((row) => row.state));

  return {
    rows,
    refreshing,
    error,
    refresh,
    turnOn,
    codexSignIn,
    startCodexSignIn,
    cancelCodexSignIn,
    noteSetupStep,
  };
}

function AgentList(props: {
  agents: AgentsModel;
  desktopApi?: DesktopApi;
  claudeSignIn?: ClaudeSignInControls;
}) {
  const { agents } = props;
  const [showMore, setShowMore] = useState(false);
  const shown = agents.rows.filter((row) => row.definition.primary
    || row.state.kind === "ready"
    || row.state.kind === "off"
    || row.state.kind === "needs-sign-in");
  const hidden = agents.rows.filter((row) => !shown.includes(row));
  const readyCount = agents.rows.filter((row) => row.state.kind === "ready").length;
  return (
    <section className="get-started__section" aria-labelledby="get-started-agents-heading">
      <div className="get-started__section-head">
        <h2 id="get-started-agents-heading" className="get-started__label">
          Agents{readyCount > 0 ? ` · ${readyCount} ready` : ""}
        </h2>
        <button
          type="button"
          className="get-started__btn get-started__btn--link"
          disabled={agents.refreshing}
          onClick={() => void agents.refresh()}
        >
          {agents.refreshing ? "Checking…" : "Check again"}
        </button>
      </div>
      <ul className="get-started__agents">
        {shown.map((row) => (
          <AgentRowView
            key={row.definition.id}
            row={row}
            agents={agents}
            desktopApi={props.desktopApi}
            claudeSignIn={props.claudeSignIn}
          />
        ))}
        {showMore
          ? hidden.map((row) => (
            <AgentRowView
              key={row.definition.id}
              row={row}
              agents={agents}
              desktopApi={props.desktopApi}
              claudeSignIn={props.claudeSignIn}
            />
          ))
          : null}
      </ul>
      {hidden.length > 0 ? (
        <button
          type="button"
          className="get-started__btn get-started__btn--link get-started__more"
          aria-expanded={showMore}
          onClick={() => setShowMore(!showMore)}
        >
          {showMore ? "Fewer agents" : `More agents (${hidden.length})`}
        </button>
      ) : null}
      {agents.error ? (
        <p className="get-started__error" role="status">{agents.error}</p>
      ) : null}
    </section>
  );
}

function AgentRowView(props: {
  row: AgentRow;
  agents: AgentsModel;
  desktopApi?: DesktopApi;
  claudeSignIn?: ClaudeSignInControls;
}) {
  const { definition, state } = props.row;
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState<string>();
  const action = getStartedAgentAction(state);
  const platform = desktopPlatform(props.desktopApi?.platform);
  const panelId = `get-started-agent-${definition.id}-panel`;
  const codexSignIn = props.agents.codexSignIn;
  const codexWaiting = definition.id === "codex"
    && (codexSignIn.kind === "waiting" || codexSignIn.kind === "starting");

  const copy = (value: string): void => {
    setCopied(undefined);
    void props.desktopApi?.copyText?.(value).then(() => setCopied(value), () => undefined);
  };

  let actionNode: ReactNode = null;
  if (codexWaiting) {
    actionNode = (
      <div className="get-started__row-actions">
        <button
          type="button"
          className="get-started__btn get-started__btn--ghost"
          disabled={codexSignIn.kind === "starting"}
          onClick={() => void props.agents.startCodexSignIn()}
        >
          {codexSignIn.kind === "starting" ? "Opening…" : "Open again"}
        </button>
        {codexSignIn.kind === "waiting" && codexSignIn.url && props.desktopApi?.copyText ? (
          <button
            type="button"
            className="get-started__btn get-started__btn--link"
            onClick={() => copy(codexSignIn.url!)}
          >
            {copied === codexSignIn.url ? "Copied" : "Copy link"}
          </button>
        ) : null}
        <button
          type="button"
          className="get-started__btn get-started__btn--link"
          onClick={props.agents.cancelCodexSignIn}
        >
          Cancel
        </button>
      </div>
    );
  } else if (action === "install") {
    actionNode = (
      <button
        type="button"
        className="get-started__btn get-started__btn--ghost"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => {
          if (!expanded) props.agents.noteSetupStep();
          setExpanded(!expanded);
        }}
      >
        Install
      </button>
    );
  } else if (action === "turn-on" && definition.id !== "codex" && definition.id !== "claude") {
    const id = definition.id;
    actionNode = (
      <button
        type="button"
        className="get-started__btn get-started__btn--ghost"
        onClick={() => void props.agents.turnOn(id)}
      >
        Turn on
      </button>
    );
  } else if (action === "sign-in" && definition.id === "codex") {
    actionNode = (
      <button
        type="button"
        className="get-started__btn get-started__btn--primary"
        onClick={() => void props.agents.startCodexSignIn()}
      >
        {codexSignIn.kind === "signed-out" && codexSignIn.cancelled
          ? "Try again"
          : "Sign in with ChatGPT"}
      </button>
    );
  } else if (action === "sign-in" && definition.id === "claude") {
    actionNode = props.claudeSignIn?.onSignIn ? (
      <button
        type="button"
        className="get-started__btn get-started__btn--primary"
        disabled={props.claudeSignIn.signingIn}
        onClick={() => {
          props.agents.noteSetupStep();
          props.claudeSignIn?.onSignIn?.();
        }}
      >
        {props.claudeSignIn.signingIn ? "Waiting for sign-in…" : "Sign in"}
      </button>
    ) : (
      <button
        type="button"
        className="get-started__btn get-started__btn--ghost"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => {
          if (!expanded) props.agents.noteSetupStep();
          setExpanded(!expanded);
        }}
      >
        Sign in
      </button>
    );
  } else if (action === "check-again") {
    actionNode = (
      <button
        type="button"
        className="get-started__btn get-started__btn--ghost"
        disabled={props.agents.refreshing}
        onClick={() => void props.agents.refresh()}
      >
        Check again
      </button>
    );
  }

  const detail = codexWaiting
    ? "Finish signing in on the page that opened. PwrAgent checks again when you come back."
    : "detail" in state ? state.detail : undefined;

  return (
    <li className={`get-started__agent is-${state.kind}`} data-agent={definition.id}>
      <div className="get-started__agent-main">
        <AgentMark mark={definition.mark} />
        <div className="get-started__agent-text">
          <span className="get-started__agent-name">{definition.name}</span>
          {detail ? <span className="get-started__agent-detail">{detail}</span> : null}
        </div>
        <AgentStatus state={state} />
        {actionNode}
      </div>
      {expanded ? (
        <div id={panelId} className="get-started__agent-panel">
          {definition.id === "claude" ? (
            <>
              <p className="get-started__agent-note">
                {state.kind === "not-installed"
                  ? "Install Claude Code from Anthropic's guide, then sign in from your terminal:"
                  : "Sign in from your terminal, then check again:"}
              </p>
              <CommandLine
                label="Claude sign-in"
                command={CLAUDE_SIGN_IN_COMMAND}
                copied={copied === CLAUDE_SIGN_IN_COMMAND}
                onCopy={props.desktopApi?.copyText ? () => copy(CLAUDE_SIGN_IN_COMMAND) : undefined}
              />
            </>
          ) : (
            definition.installCommands[platform].map((install) => (
              <CommandLine
                key={install.command}
                label={install.label}
                command={install.command}
                copied={copied === install.command}
                onCopy={props.desktopApi?.copyText ? () => copy(install.command) : undefined}
              />
            ))
          )}
          {definition.platformNotes?.[platform] ? (
            <p className="get-started__agent-note">{definition.platformNotes[platform]}</p>
          ) : null}
          <a href={definition.docsUrl} target="_blank" rel="noreferrer" className="get-started__agent-link">
            Official setup guide
          </a>
          <p className="get-started__agent-note">
            Run it in a terminal. PwrAgent checks again when you come back to this window.
          </p>
        </div>
      ) : null}
    </li>
  );
}

function AgentStatus(props: { state: GetStartedAgentState }) {
  switch (props.state.kind) {
    case "ready":
      return (
        <span className="get-started__status get-started__status--ok">
          <CheckIcon size={12} />
          Ready
        </span>
      );
    case "checking":
      return <span className="get-started__status get-started__status--info">Checking…</span>;
    case "needs-sign-in":
      return <span className="get-started__status get-started__status--warn">Needs sign-in</span>;
    case "off":
      return <span className="get-started__status get-started__status--muted">Installed, off</span>;
    case "error":
      return <span className="get-started__status get-started__status--warn">Can&rsquo;t start</span>;
    case "not-installed":
      return <span className="get-started__status get-started__status--muted">Not installed</span>;
  }
}

function CommandLine(props: {
  label: string;
  command: string;
  copied: boolean;
  onCopy?: () => void;
}) {
  return (
    <div className="get-started__command">
      <span className="get-started__command-label">{props.label}</span>
      <code className="get-started__command-text">{props.command}</code>
      {props.onCopy ? (
        <button
          type="button"
          className="get-started__btn get-started__btn--link"
          aria-label={`Copy ${props.label} command`}
          onClick={props.onCopy}
        >
          {props.copied ? "Copied" : "Copy"}
        </button>
      ) : null}
    </div>
  );
}

function AgentMark(props: { mark: AgentDefinition["mark"] }) {
  return (
    <span aria-hidden="true" className={`get-started__mark get-started__mark--${props.mark}`}>
      {props.mark === "codex" ? <OpenAIIcon /> : props.mark === "grok" ? <GrokIcon /> : <TerminalIcon />}
    </span>
  );
}

/* ----------------------------------------------------------------
   Named profile
   ---------------------------------------------------------------- */

/**
 * Shown when the launch named a profile that does not exist yet
 * (`--profile work` or `PWRAGENT_PROFILE=work`). The name is the user's
 * intent, so it is confirmed before anything is created.
 */
function ConfirmProfile(props: {
  name: string;
  submitting: boolean;
  onContinue: () => void;
  onQuit: () => void;
}) {
  return (
    <>
      <div className="get-started__body get-started__body--center">
        <h1 className="get-started__title">
          Set up <code>{props.name}</code>?
        </h1>
        <p className="get-started__sub">
          PwrAgent doesn&rsquo;t have a profile named <code>{props.name}</code>{" "}
          yet. This launch asked for it with <code>--profile</code> or{" "}
          <code>PWRAGENT_PROFILE</code>. Set it up now, or quit and launch
          with a different name.
        </p>
        <p className="get-started__fine">
          Your existing profiles and your Codex login at <code>~/.codex/</code>{" "}
          stay as they are.
        </p>
      </div>
      <footer className="get-started__footer">
        <button
          type="button"
          className="get-started__btn get-started__btn--ghost"
          disabled={props.submitting}
          onClick={props.onQuit}
        >
          Quit PwrAgent
        </button>
        <span className="get-started__spacer" />
        <button
          type="button"
          className="get-started__btn get-started__btn--primary"
          disabled={props.submitting}
          onClick={props.onContinue}
        >
          Set up <code>{props.name}</code>
        </button>
      </footer>
    </>
  );
}

/** Which Codex login a named profile uses. Only asked for a named profile. */
function CodexLoginChoice(props: {
  profileName: string;
  separate: boolean;
  onChange: (separate: boolean) => void;
}) {
  const options = [
    {
      separate: true,
      title: "A separate Codex login",
      detail: `${props.profileName} signs in to Codex on its own, after setup. Your other Codex work stays apart.`,
    },
    {
      separate: false,
      title: "This computer's Codex login",
      detail: "Shares the login at ~/.codex/. Your Codex threads appear here too.",
    },
  ];
  return (
    <section className="get-started__section" aria-labelledby="get-started-login-heading">
      <h2 id="get-started-login-heading" className="get-started__label">
        Codex login for {props.profileName}
      </h2>
      <div className="get-started__choices" role="radiogroup" aria-labelledby="get-started-login-heading">
        {options.map((option) => (
          <button
            key={String(option.separate)}
            type="button"
            role="radio"
            aria-checked={props.separate === option.separate}
            className={`get-started__choice${props.separate === option.separate ? " is-selected" : ""}`}
            onClick={() => props.onChange(option.separate)}
          >
            <span className="get-started__choice-title">{option.title}</span>
            <span className="get-started__choice-detail">{option.detail}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------
   Close in the bootstrap profile
   ---------------------------------------------------------------- */

/**
 * Closing first run in the bootstrap profile cannot simply close: either a
 * profile is made, or PwrAgent quits. Focus starts on the choice that
 * changes nothing.
 */
function DismissConfirmModal(props: {
  /** The profile the launch asked for, if any. */
  profileName?: string;
  /** Which Codex login that profile gets; its confirm step may hide the choice. */
  separateLogin: boolean;
  submitting: boolean;
  onCancel: () => void;
  onContinueWithoutAgent: () => void;
  onExit: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const modalRef = useModalDialog({
    onClose: () => {
      if (!props.submitting) props.onCancel();
    },
    initialFocus: cancelRef,
  });
  return (
    <div
      ref={modalRef}
      className="get-started__dismiss"
      role="dialog"
      aria-modal="true"
      aria-labelledby="get-started-dismiss-heading"
    >
      <div className="get-started__dismiss-scrim" />
      <div className="get-started__dismiss-body">
        <h2 id="get-started-dismiss-heading" className="get-started__dismiss-title">
          Skip setup?
        </h2>
        {props.profileName ? (
          <p className="get-started__dismiss-prose">
            PwrAgent will create the <code>{props.profileName}</code> profile
            {props.separateLogin ? (
              <> with its own Codex login, which you sign in to after setup.</>
            ) : (
              <> with this computer&rsquo;s Codex login at <code>~/.codex/</code>.</>
            )}{" "}
            You can set up agents later in Settings.
          </p>
        ) : (
          <>
            <p className="get-started__dismiss-prose">
              PwrAgent will create a <code>default</code> profile that uses
              this computer&rsquo;s Codex login at <code>~/.codex/</code>, so
              your Codex threads appear in the sidebar. You can set up agents
              later in Settings.
            </p>
            <p className="get-started__dismiss-prose">
              To keep PwrAgent apart from your Codex account, quit and launch
              with <code>--profile</code> and a new name instead.
            </p>
          </>
        )}
        <div className="get-started__dismiss-actions">
          <button
            type="button"
            className="get-started__btn get-started__btn--link"
            disabled={props.submitting}
            onClick={props.onExit}
          >
            Quit PwrAgent
          </button>
          <span className="get-started__spacer" />
          <button
            ref={cancelRef}
            type="button"
            className="get-started__btn get-started__btn--ghost"
            disabled={props.submitting}
            onClick={props.onCancel}
          >
            Back to setup
          </button>
          <button
            type="button"
            className="get-started__btn get-started__btn--primary"
            disabled={props.submitting}
            onClick={props.onContinueWithoutAgent}
          >
            Continue without an agent
          </button>
        </div>
      </div>
    </div>
  );
}
