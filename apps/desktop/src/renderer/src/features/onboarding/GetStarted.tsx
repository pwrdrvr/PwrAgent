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
  DiscoverRecentProjectsRequest,
  DiscoverRecentProjectsResponse,
  RecentProjectAgent,
} from "@pwragent/shared/contracts/settings";
import { mergeRecentProjectDiscoveries } from "@pwragent/shared/recent-project-discovery";
import type { DesktopApi } from "../../lib/desktop-api";
import { ipcErrorMessage } from "../../lib/open-path-failure";
import { BACKEND_SUMMARIES_REFRESH_EVENT } from "../../lib/useBackendSummaries";
import { useModalDialog } from "../../lib/useModalDialog";
import type { ClaudeSignInControls } from "../notifications/useClaudeSignIn";
import { findCodexLaunchFailure } from "../notifications/CodexLaunchNotice";
import { ManagedRuntimeProgressStrip, useManagedRuntimeProgress } from "../settings/ManagedRuntimeProgress";
import type { DesktopSettingsState } from "../settings/useDesktopSettings";
import type { ManagedRuntimeProgress } from "../../../../shared/managed-runtime-progress";
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
  codexInstallOffer,
  getStartedAgentAction,
  selectedCodexCandidate,
  type CodexInstallOffer,
  type CodexSignInState,
  type GetStartedAgentState,
} from "./get-started-agents";
import {
  checkedProjectPaths,
  compareAgents,
  isProjectChecked,
  keepListedChoices,
  projectRecencyLabel,
  projectScanNotices,
  rankProjectCandidates,
  splitProjectCandidates,
  type ProjectCandidate,
  type ProjectScanNotice,
} from "./get-started-projects";
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
  const [startError, setStartError] = useState<string>();
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

  // Codex projects are read with the Codex this page finds, so the first
  // look waits for the first agent check, and looks again once a Codex
  // turns up. A replay never imports projects again, so it does not look.
  const [agentsChecked, setAgentsChecked] = useState(false);
  useEffect(() => {
    if (!agents.refreshing) setAgentsChecked(true);
  }, [agents.refreshing]);
  // Claude Code's history is read only once it is signed in, so a sign-in
  // or install on this page looks again. Once is enough: a later recheck
  // that passes through "checking" must not throw away the list.
  const claudeReady = agents.rows.some((row) => row.definition.id === "claude" && row.state.kind === "ready");
  const [claudeWasReady, setClaudeWasReady] = useState(false);
  useEffect(() => {
    if (claudeReady) setClaudeWasReady(true);
  }, [claudeReady]);
  const projects = useGetStartedProjects({
    desktopApi: props.desktopApi,
    enabled: !props.isReplay,
    ready: agentsChecked,
    includeCodex: !separateLogin,
    codexInstalled: Boolean(selectedCodexCandidate(props.settings.snapshot)),
    claudeReady: claudeWasReady,
  });
  const checkedPathsRef = useRef<string[]>([]);
  checkedPathsRef.current = projects.checkedPaths;

  // An in-app Claude Code sign-in ends when its CLI exits, which can come
  // after the window regains focus. Check again then, so the row does not
  // keep saying Needs sign-in.
  const claudeSigningIn = props.claudeSignIn?.signingIn ?? false;
  const wasClaudeSigningIn = useRef(claudeSigningIn);
  const refreshAgents = agents.refresh;
  useEffect(() => {
    if (wasClaudeSigningIn.current && !claudeSigningIn) void refreshAgents();
    wasClaudeSigningIn.current = claudeSigningIn;
  }, [claudeSigningIn, refreshAgents]);

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
      // The new profile registers these the first time it starts; this
      // bootstrap profile's own state is thrown away.
      const seedProjectPaths = checkedPathsRef.current;
      if (useSeparateLogin) {
        // A PwrAgent profile paired with a Codex login of the same name.
        // Its Codex sign-in happens in the new window, under Settings →
        // Profiles, so this page never signs in the wrong account.
        target = (await provisionPairedProfiles(api, [profileName], { seedProjectPaths }))[0];
      } else {
        // No Codex pairing means this computer's own Codex login.
        await api.createPwrAgentProfile({
          profile: profileName,
          seedOnboardingCompleted: true,
          ...(seedProjectPaths.length > 0 ? { seedProjectPaths } : {}),
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
      setStartError(undefined);
      try {
        if (props.isReplay || !inBootstrapMode) {
          if (!props.isReplay) await registerCheckedProjects(props.desktopApi, checkedPathsRef.current);
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
        setStartError(caught instanceof Error ? caught.message : String(caught));
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
              {projects.status === "off" ? null : <ProjectList projects={projects} />}
              {startError ? (
                <p className="get-started__error" role="alert">
                  PwrAgent couldn&rsquo;t finish setting up: {startError}
                </p>
              ) : null}
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

type AcpAgentId = Exclude<keyof DesktopSettingsSnapshot["acpAgents"], "antigravity">;
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

const NATIVE_AGENTS: readonly AgentDefinition[] = [
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
];

const ACP_AGENT_DEFINITIONS: Record<AcpAgentId, Omit<AgentDefinition, "id">> = {
  gemini: {
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
  kimi: {
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
  qwen: {
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
  grok: {
    name: "Grok Build",
    mark: "grok",
    docsUrl: "https://docs.x.ai/build/overview",
    installCommands: {
      darwin: [{ label: "Recommended", command: "curl -fsSL https://x.ai/cli/install.sh | bash" }],
      linux: [{ label: "Recommended", command: "curl -fsSL https://x.ai/cli/install.sh | bash" }],
      win32: [{ label: "PowerShell", command: "irm https://x.ai/cli/install.ps1 | iex" }],
    },
  },
};

const ACP_AGENT_IDS = Object.keys(ACP_AGENT_DEFINITIONS) as AcpAgentId[];
const AGENTS: readonly AgentDefinition[] = [
  ...NATIVE_AGENTS,
  ...ACP_AGENT_IDS.map((id) => ({ id, ...ACP_AGENT_DEFINITIONS[id] })),
];

const ACP_AGENT_TRADEMARKS: Record<AcpAgentId, string> = {
  grok: "Grok and the Grok logo are trademarks of SpaceXAI, formerly xAI.",
  gemini: "Gemini is a trademark of Google LLC.",
  kimi: "Kimi is a trademark of Moonshot AI.",
  qwen: "Qwen is a trademark of Alibaba Cloud.",
};

const { grok: grokTrademark, ...otherAcpTrademarks } = ACP_AGENT_TRADEMARKS;
const TRADEMARK_NOTE = [
  "OpenAI, Codex, and the OpenAI logo are trademarks of OpenAI.",
  grokTrademark,
  "Claude is a trademark of Anthropic.",
  ...Object.values(otherAcpTrademarks),
  "PwrAgent is independently developed and is not affiliated with, endorsed by, or sponsored by any of them.",
].join(" ");

const CLAUDE_SIGN_IN_COMMAND = "claude auth login";

type AgentRow = { definition: AgentDefinition; state: GetStartedAgentState };

export type AgentsModel = {
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
  /** The command that signs in the Claude Code CLI PwrAgent found. */
  claudeLoginCommand: string;
  codexInstall: CodexInstallModel;
};

/** PwrAgent installing OpenAI’s Codex from this page. */
type CodexInstallModel = {
  offer?: CodexInstallOffer;
  installing: boolean;
  error?: string;
  progress?: ManagedRuntimeProgress;
  install: () => Promise<void>;
};

function desktopPlatform(platform?: string): DesktopPlatform {
  if (platform === "win32" || platform === "linux") return platform;
  return "darwin";
}

function acpEnabled(snapshot: DesktopSettingsSnapshot | undefined, id: AcpAgentId): boolean {
  return snapshot?.acpAgents?.[id]?.enabled !== false;
}

/**
 * Discovery and sign-in for every row. Discovery runs once as the page
 * opens, again on Check again, and again when the window regains focus
 * after an install or a browser sign-in. Nothing installs or signs in
 * until its button is clicked.
 */
export function useGetStartedAgents(params: {
  settings: DesktopSettingsState;
  desktopApi?: DesktopApi;
  separateLogin: boolean;
  /**
   * The Codex login Codex's row checks and signs in to. First run signs in
   * to this computer's own (`""`, `~/.codex/`); an existing profile signs in
   * to the one it runs Codex with.
   */
  codexAuthProfile?: string;
  /**
   * When coming back to the window rechecks every agent. Get started does
   * while no agent is ready yet; a page that can stay up indefinitely only
   * after the user opened an install or sign-in step from it.
   */
  recheckOnFocus?: "while-not-ready" | "after-setup-step";
}): AgentsModel {
  const { settings, desktopApi, separateLogin } = params;
  const codexAuthProfile = params.codexAuthProfile ?? "";
  const codexAuthProfileRef = useRef(codexAuthProfile);
  codexAuthProfileRef.current = codexAuthProfile;
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
      const result = await api.checkCodexAuthProfileStatus({ profile: codexAuthProfileRef.current });
      setCodexSignIn((current) => result.authenticated
        ? { kind: "signed-in", email: result.email, planType: result.planType }
        : keep(current)
          ? current
          : { kind: "signed-out", detail: result.detail });
    } catch (caught) {
      setCodexSignIn({ kind: "error", detail: caught instanceof Error ? caught.message : String(caught) });
    }
  }, []);

  const refreshAgainRef = useRef(false);
  const refresh = useCallback(async (): Promise<void> => {
    if (refreshingRef.current) {
      // A check asked for mid-flight may follow something the running one
      // started too early to see, such as a sign-in that just finished.
      refreshAgainRef.current = true;
      return;
    }
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
      if (refreshAgainRef.current) {
        refreshAgainRef.current = false;
        void refreshRef.current();
      } else {
        setRefreshing(false);
      }
    }
  }, [checkCodexSignIn]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

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
      // First run: this computer's own login, the empty profile `~/.codex/`.
      const result = await api.startCodexAuthProfileLogin({ profile: codexAuthProfileRef.current });
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
  const codexDiscovering = refreshing && !selectedCodexCandidate(snapshot);
  const codexInstall = useCodexInstall({
    snapshot,
    discovering: codexDiscovering,
    desktopApi,
    refresh,
  });
  const rows = useMemo((): AgentRow[] => AGENTS.map((definition) => {
    let state: GetStartedAgentState;
    if (definition.id === "codex") {
      state = codexAgentState({
        snapshot,
        discovering: codexDiscovering,
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
  }), [acpEntries, backends, codexDiscovering, codexSignIn, optimisticEnabled, separateLogin, snapshot]);

  recheckOnFocusRef.current = codexSignIn.kind === "waiting"
    || (params.recheckOnFocus !== "after-setup-step" && !canStartWithAgents(rows.map((row) => row.state)));

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
    // The bundled CLI is not on PATH, so its command names it by path.
    claudeLoginCommand: backends?.find((backend) => backend.kind === "claude")?.claude?.loginCommand
      ?? CLAUDE_SIGN_IN_COMMAND,
    codexInstall,
  };
}

/**
 * Install OpenAI's Codex for a user with no working Codex, as T3 Code does,
 * instead of sending them to a terminal. The request downloads, verifies and
 * places the latest release under the PwrAgent root before it returns; the
 * discovery it runs makes that the Codex this page signs in with, and PwrAgent
 * keeps it current from then on. A user-installed Codex that works still wins.
 */
function useCodexInstall(params: {
  snapshot: DesktopSettingsSnapshot | undefined;
  discovering: boolean;
  desktopApi?: DesktopApi;
  refresh: () => Promise<void>;
}): CodexInstallModel {
  const { snapshot, discovering, desktopApi, refresh } = params;
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string>();
  const progress = useManagedRuntimeProgress(desktopApi, "openai-codex");
  const offer = codexInstallOffer({
    snapshot,
    discovering,
    launchFailure: findCodexLaunchFailure(snapshot?.models?.codex?.discovery),
  });
  const install = useCallback(async (): Promise<void> => {
    setInstalling(true);
    setError(undefined);
    try {
      if (!desktopApi?.refreshCodexDiscovery) {
        setError("PwrAgent couldn't install Codex. Install it yourself instead.");
        return;
      }
      await desktopApi.refreshCodexDiscovery({
        discoveryIntent: "setup-user-action",
        installOpenAiCodex: true,
      });
      await refresh();
    } catch (caught) {
      setError(ipcErrorMessage(caught));
    } finally {
      setInstalling(false);
    }
  }, [desktopApi, refresh]);
  return {
    offer,
    installing,
    ...(error ? { error } : {}),
    ...(progress ? { progress } : {}),
    install,
  };
}

export function AgentList(props: {
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
  const codexInstall = props.agents.codexInstall;
  const codexInstallOffer = definition.id === "codex" ? codexInstall.offer : undefined;
  const codexProgress = definition.id === "codex" ? codexInstall.progress : undefined;
  const codexInstalling = codexInstall.installing
    || (codexProgress !== undefined && codexProgress.phase !== "ready" && codexProgress.phase !== "failed");

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
  } else if (action === "install" && codexInstallOffer) {
    actionNode = (
      <button
        type="button"
        className="get-started__btn get-started__btn--primary"
        disabled={codexInstalling}
        onClick={() => void props.agents.codexInstall.install()}
      >
        {codexInstalling ? "Installing…" : "Install Codex"}
      </button>
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
    : codexInstallOffer?.reason === "missing" && state.kind === "not-installed"
      ? "PwrAgent can install OpenAI’s Codex for you and keep it up to date."
      : codexInstallOffer?.reason === "broken" && state.kind === "not-installed"
        ? "The Codex on this computer doesn't start. PwrAgent can install OpenAI’s Codex for you."
        : "detail" in state ? state.detail : undefined;
  const showCodexInstallPanel = definition.id === "codex"
    && (codexInstallOffer !== undefined || codexProgress !== undefined || codexInstall.error !== undefined);

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
      {showCodexInstallPanel ? (
        <CodexInstallPanel
          install={codexInstall}
          installing={codexInstalling}
          manualOpen={expanded}
          manualPanelId={panelId}
          onToggleManual={state.kind === "not-installed" ? () => {
            if (!expanded) props.agents.noteSetupStep();
            setExpanded(!expanded);
          } : undefined}
        />
      ) : null}
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
                command={props.agents.claudeLoginCommand}
                copied={copied === props.agents.claudeLoginCommand}
                onCopy={props.desktopApi?.copyText ? () => copy(props.agents.claudeLoginCommand) : undefined}
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

function CodexInstallPanel(props: {
  install: CodexInstallModel;
  installing: boolean;
  manualOpen: boolean;
  manualPanelId: string;
  /** Present while no Codex works: the copy-paste commands stay one click away. */
  onToggleManual?: () => void;
}) {
  const { install } = props;
  const offer = install.offer;
  return (
    <div className="get-started__agent-panel">
      {install.progress ? (
        <ManagedRuntimeProgressStrip
          progress={install.progress}
          onRetry={props.installing ? undefined : () => void install.install()}
        />
      ) : null}
      {offer?.reason === "outdated" && !install.progress ? (
        <>
          <p className="get-started__agent-note">
            Codex {offer.version} is too old for the newest models, which need
            Codex {offer.minimumVersion} or later. PwrAgent can install
            OpenAI’s latest Codex and keep it up to date.
          </p>
          <div className="get-started__row-actions">
            <button
              type="button"
              className="get-started__btn get-started__btn--ghost"
              disabled={props.installing}
              onClick={() => void install.install()}
            >
              {props.installing ? "Installing…" : "Install latest Codex"}
            </button>
          </div>
        </>
      ) : null}
      {install.error && install.progress?.phase !== "failed" ? (
        <p className="get-started__error" role="status">{install.error}</p>
      ) : null}
      {props.onToggleManual && offer?.reason !== "outdated" ? (
        <button
          type="button"
          className="get-started__btn get-started__btn--link"
          aria-expanded={props.manualOpen}
          aria-controls={props.manualPanelId}
          onClick={props.onToggleManual}
        >
          {props.manualOpen ? "Hide install commands" : "Install it yourself instead"}
        </button>
      ) : null}
    </div>
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
   Projects
   ---------------------------------------------------------------- */

type ProjectsModel = {
  /**
   * `off` in a replay, or on a bridge that cannot look. `ready` once either
   * part of the search answered; `pending` says the other is still out.
   */
  status: "off" | "loading" | "ready";
  pending: boolean;
  candidates: ProjectCandidate[];
  notices: ProjectScanNotice[];
  agentLabels: ReadonlyMap<RecentProjectAgent, string>;
  /** When the result arrived; recency is measured from it, not from render. */
  readAt: number;
  isChecked: (candidate: ProjectCandidate) => boolean;
  toggle: (candidate: ProjectCandidate) => void;
  checkedPaths: string[];
};

/** One part's answer, or why it has none. */
type ProjectPartAnswer = {
  response: DiscoverRecentProjectsResponse;
  /** The request itself failed: no read in the part answered. */
  failure?: string;
  readAt: number;
};

/**
 * Asks for one part of the search. Only the newest request for a part may
 * set its answer: a slower, older one that answers last is dropped.
 */
function askForProjectPart(
  discover: NonNullable<DesktopApi["discoverRecentProjects"]>,
  request: DiscoverRecentProjectsRequest,
  requestRef: { current: number },
  setAnswer: (answer: ProjectPartAnswer | undefined) => void,
  /** Runs just before an answer is shown, while the list is still the old one. */
  beforeAnswer: () => void,
): void {
  const id = ++requestRef.current;
  setAnswer(undefined);
  discover(request).then((response) => {
    if (id !== requestRef.current) return;
    beforeAnswer();
    setAnswer({ response, readAt: Date.now() });
  }, (caught: unknown) => {
    if (id !== requestRef.current) return;
    beforeAnswer();
    setAnswer({
      response: { sources: [], observations: [] },
      failure: caught instanceof Error ? caught.message : String(caught),
      readAt: Date.now(),
    });
  });
}

/**
 * Recent project folders from every agent PwrAgent may read, newest first.
 * The most recent start checked. Two parts are asked for at once: Codex with
 * PwrAgent's own threads, and Claude Code's history, so a slow history read
 * never holds back the list. Each part shows when it answers; a row the
 * operator toggled keeps that choice as the other part's rows arrive. The
 * agents part looks again when the Codex login choice changes, since a
 * separate login's projects are not this computer's, or a Codex is found;
 * the history part looks again when Claude Code is first ready, since it
 * could not be read before.
 */
function useGetStartedProjects(params: {
  desktopApi?: DesktopApi;
  /** False in a replay, which never looks. */
  enabled: boolean;
  /** False until the first agent check ends. */
  ready: boolean;
  includeCodex: boolean;
  codexInstalled: boolean;
  /** True from the first time Claude Code was ready on this page. */
  claudeReady: boolean;
}): ProjectsModel {
  const { desktopApi, enabled, ready, includeCodex, codexInstalled, claudeReady } = params;
  const available = enabled && Boolean(desktopApi?.discoverRecentProjects);
  const [agentsAnswer, setAgentsAnswer] = useState<ProjectPartAnswer>();
  const [historyAnswer, setHistoryAnswer] = useState<ProjectPartAnswer>();
  const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(new Map());
  const agentsRequestRef = useRef(0);
  const historyRequestRef = useRef(0);
  const listedRef = useRef<readonly ProjectCandidate[]>([]);
  // An answer re-ranks the list, so the rows already listed keep the state
  // they show before it lands.
  const keepListed = useCallback((): void => {
    setChoices((current) => keepListedChoices(listedRef.current, current));
  }, []);

  useEffect(() => {
    const discover = desktopApi?.discoverRecentProjects;
    if (!enabled || !ready || !discover) return;
    askForProjectPart(discover, { part: "agents", includeCodex }, agentsRequestRef, setAgentsAnswer, keepListed);
  }, [codexInstalled, desktopApi, enabled, includeCodex, keepListed, ready]);

  useEffect(() => {
    const discover = desktopApi?.discoverRecentProjects;
    if (!enabled || !ready || !discover) return;
    askForProjectPart(discover, { part: "claude-history" }, historyRequestRef, setHistoryAnswer, keepListed);
  }, [claudeReady, desktopApi, enabled, keepListed, ready]);

  const result = useMemo(() => {
    // The history answer first, so its detail wins a tie, as in one request.
    const answers = [historyAnswer, agentsAnswer].filter((answer) => answer !== undefined);
    if (answers.length === 0) return undefined;
    const merged = mergeRecentProjectDiscoveries(answers.map((answer) => answer.response));
    const sources = [...merged.sources].sort((left, right) => compareAgents(left.agent, right.agent));
    const agentLabels = new Map<RecentProjectAgent, string>();
    for (const source of sources) agentLabels.set(source.agent, source.label);
    const notices: ProjectScanNotice[] = [];
    if (agentsAnswer?.failure !== undefined) {
      notices.push({ agent: "codex", tone: "failed", text: `Recent projects couldn't be read: ${agentsAnswer.failure}` });
    }
    if (historyAnswer?.failure !== undefined) {
      notices.push({ agent: "claude", tone: "failed", text: `Claude Code couldn't be read: ${historyAnswer.failure}` });
    }
    return {
      candidates: rankProjectCandidates(merged.observations),
      notices: [...notices, ...projectScanNotices(sources)],
      agentLabels,
      readAt: Math.max(...answers.map((answer) => answer.readAt)),
    };
  }, [agentsAnswer, historyAnswer]);

  const toggle = useCallback((candidate: ProjectCandidate): void => {
    setChoices((current) => {
      const next = new Map(current);
      next.set(candidate.key, !isProjectChecked(candidate, current));
      return next;
    });
  }, []);
  const isChecked = useCallback(
    (candidate: ProjectCandidate): boolean => isProjectChecked(candidate, choices),
    [choices],
  );
  const candidates = result?.candidates;
  listedRef.current = candidates ?? [];
  const checkedPaths = useMemo(
    () => (candidates ? checkedProjectPaths(candidates, choices) : []),
    [candidates, choices],
  );

  return {
    status: !available ? "off" : result ? "ready" : "loading",
    pending: available && (!agentsAnswer || !historyAnswer),
    candidates: result?.candidates ?? [],
    notices: result?.notices ?? [],
    agentLabels: result?.agentLabels ?? new Map(),
    readAt: result?.readAt ?? 0,
    isChecked,
    toggle,
    checkedPaths: available ? checkedPaths : [],
  };
}

/** Start in an existing profile registers the checked folders here. */
async function registerCheckedProjects(api: DesktopApi | undefined, paths: readonly string[]): Promise<void> {
  if (!api?.registerDirectoryFromDisk) return;
  for (const folder of paths) {
    try {
      const result = await api.registerDirectoryFromDisk({ path: folder });
      if (!result.ok) console.warn(`Get started: couldn't add ${folder}: ${result.message}`);
    } catch (caught) {
      console.warn(`Get started: couldn't add ${folder}`, caught);
    }
  }
}

function ProjectList(props: { projects: ProjectsModel }) {
  const { projects } = props;
  const [showAll, setShowAll] = useState(false);
  const { shown, collapsed } = splitProjectCandidates(projects.candidates);
  const checkedCount = projects.checkedPaths.length;
  return (
    <section className="get-started__section" aria-labelledby="get-started-projects-heading">
      <div className="get-started__section-head">
        <h2 id="get-started-projects-heading" className="get-started__label">
          Projects{checkedCount > 0 ? ` · ${checkedCount} selected` : ""}
        </h2>
      </div>
      {projects.status === "loading" || (projects.pending && projects.candidates.length === 0) ? (
        <p className="get-started__fine" role="status">Looking for recent projects…</p>
      ) : projects.candidates.length === 0 ? (
        <p className="get-started__fine">
          No recent projects found. You can add folders any time.
        </p>
      ) : (
        <ul className="get-started__agents get-started__projects">
          {[...shown, ...(showAll ? collapsed : [])].map((candidate) => (
            <ProjectRow
              key={candidate.key}
              candidate={candidate}
              checked={projects.isChecked(candidate)}
              agentLabels={projects.agentLabels}
              readAt={projects.readAt}
              onToggle={() => projects.toggle(candidate)}
            />
          ))}
        </ul>
      )}
      {collapsed.length > 0 ? (
        <button
          type="button"
          className="get-started__btn get-started__btn--link get-started__more"
          aria-expanded={showAll}
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? "Show fewer" : `Review all (${projects.candidates.length})`}
        </button>
      ) : null}
      {projects.pending && projects.candidates.length > 0 ? (
        <p className="get-started__fine" role="status">Looking for more recent projects…</p>
      ) : null}
      {projects.notices.map((notice, index) => (
        <p key={`${notice.agent}-${notice.tone}-${index}`} className="get-started__notice" role="status">
          {notice.text}
        </p>
      ))}
      <p className="get-started__fine">
        Codex threads in these folders appear on their own when this profile
        shares this computer&rsquo;s Codex login.
      </p>
    </section>
  );
}

/** One state (checked or not) and one action (toggle it). */
function ProjectRow(props: {
  candidate: ProjectCandidate;
  checked: boolean;
  agentLabels: ReadonlyMap<RecentProjectAgent, string>;
  readAt: number;
  onToggle: () => void;
}) {
  const { candidate } = props;
  const agents = candidate.agents
    .map((agent) => props.agentLabels.get(agent) ?? agent)
    .join(", ");
  const recency = projectRecencyLabel(candidate.lastActiveAt, props.readAt);
  return (
    <li className="get-started__agent get-started__project" data-project={candidate.path}>
      <label className="get-started__project-main">
        <input
          type="checkbox"
          className="get-started__check-input"
          checked={props.checked}
          onChange={props.onToggle}
        />
        <span aria-hidden="true" className={`get-started__check${props.checked ? " is-checked" : ""}`} />
        <span className="get-started__agent-text">
          <span className="get-started__agent-name">{candidate.label}</span>
          <span className="get-started__project-path">{candidate.path}</span>
        </span>
        <span className="get-started__project-meta">
          {recency ? `${agents} · ${recency}` : agents}
        </span>
      </label>
    </li>
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
