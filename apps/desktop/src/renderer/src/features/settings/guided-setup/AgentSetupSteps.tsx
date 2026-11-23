import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AcpAgentSettingsEntry,
  BackendSummary,
} from "@pwragent/shared/contracts/backend";
import type {
  DesktopSettingsConfigPatch,
  DesktopSettingsSnapshot,
} from "@pwragent/shared/contracts/settings";
import type { DesktopApi } from "../../../lib/desktop-api";
import { BACKEND_SUMMARIES_REFRESH_EVENT } from "../../../lib/useBackendSummaries";
import type { ClaudeSignInControls } from "../../notifications/useClaudeSignIn";
import { claudeProviderStatus } from "../claude-provider-status";
import { SettingsSwitch } from "../SettingsSwitch";
import type { DesktopSettingsState } from "../useDesktopSettings";
import {
  CodexLoginRow,
  useCodexProfileLogin,
  type RowLoginState,
} from "./CodexLoginRow";
import { ReviewSummary } from "./ReviewSummary";
import { SetupMark, type SetupMarkId } from "./SetupMark";

/*
 * Agent steps for Settings' guided setup: pick an agent and install it,
 * sign in, review. The install catalogue is copied from first-run
 * onboarding. Opening a step reads only what PwrAgent already knows;
 * discovery, sign-in, and login checks each wait for a click, because each
 * launches the provider's CLI.
 */

/** An ACP agent PwrAgent supports: one per key of the settings contract's
 *  `acpAgents`. */
type AcpAgentId = Exclude<keyof DesktopSettingsSnapshot["acpAgents"], "antigravity">;

export type AgentBackendId = "codex" | AcpAgentId;

type AgentDesktopPlatform = "darwin" | "win32" | "linux";
type AgentInstallCommand = { label: string; command: string };

function agentDesktopPlatform(platform?: string): AgentDesktopPlatform {
  if (platform === "win32" || platform === "linux") return platform;
  return "darwin";
}

function agentPlatformLabel(platform: AgentDesktopPlatform): string {
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  return "macOS";
}

type AgentBackendDefinition = {
  name: string;
  description: string;
  /**
   * The vendor's official mark, shown on the provider card. OpenAI and
   * SpaceXAI publish terms that let an integrator show their mark to
   * identify the product. Kimi's logo license covers only editorial and
   * non-commercial use, Qwen's terms require written consent, and Google
   * asks for a permission request, so those three keep a generic glyph
   * until the vendor agrees.
   */
  mark?: Extract<SetupMarkId, "codex" | "grok">;
  /** The company the non-affiliation note names. */
  vendor: string;
  /** The trademark attribution sentence that opens that note. */
  trademarks: string;
  docsUrl: string;
  installCommands: Record<
    AgentDesktopPlatform,
    ReadonlyArray<AgentInstallCommand>
  >;
  platformNotes?: Partial<Record<AgentDesktopPlatform, string>>;
};

const CODEX_BACKEND: AgentBackendDefinition = {
  name: "Codex CLI",
  description:
    "OpenAI's coding agent. Sign in with your ChatGPT account after install.",
  mark: "codex",
  vendor: "OpenAI",
  trademarks: "OpenAI, Codex, and the OpenAI logo are trademarks of OpenAI.",
  docsUrl: "https://learn.chatgpt.com/docs/codex/cli#getting-started",
  installCommands: {
    darwin: [
      {
        label: "Recommended",
        command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
      },
      { label: "Homebrew", command: "brew install --cask codex" },
      { label: "npm", command: "npm install -g @openai/codex" },
    ],
    linux: [
      {
        label: "Recommended",
        command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
      },
      { label: "npm", command: "npm install -g @openai/codex" },
    ],
    win32: [
      {
        label: "PowerShell (recommended)",
        command:
          'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
      },
      { label: "npm", command: "npm install -g @openai/codex" },
    ],
  },
};

/**
 * The ACP agents offered in guided setup. Antigravity is configured in
 * AI Providers. Key order is tab order.
 */
const ACP_AGENT_BACKENDS: Record<AcpAgentId, AgentBackendDefinition> = {
  gemini: {
    name: "Gemini CLI",
    description:
      "Google's terminal coding agent with Google-account and API-key login options.",
    vendor: "Google",
    trademarks: "Gemini is a trademark of Google LLC.",
    docsUrl: "https://geminicli.com/docs/get-started/installation/",
    installCommands: {
      darwin: [
        { label: "Homebrew", command: "brew install gemini-cli" },
        { label: "npm", command: "npm install -g @google/gemini-cli" },
      ],
      linux: [
        { label: "npm", command: "npm install -g @google/gemini-cli" },
      ],
      win32: [
        { label: "npm", command: "npm install -g @google/gemini-cli" },
      ],
    },
  },
  kimi: {
    name: "Kimi Code",
    description:
      "Moonshot AI's Node.js coding agent. Run /login for OAuth or an API key.",
    vendor: "Moonshot AI",
    trademarks: "Kimi is a trademark of Moonshot AI.",
    docsUrl: "https://moonshotai.github.io/kimi-code/en/guides/getting-started",
    installCommands: {
      darwin: [
        {
          label: "Recommended",
          command: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
        },
        {
          label: "npm (Node.js 22.19+)",
          command: "npm install -g @moonshot-ai/kimi-code",
        },
      ],
      linux: [
        {
          label: "Recommended",
          command: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
        },
        {
          label: "npm (Node.js 22.19+)",
          command: "npm install -g @moonshot-ai/kimi-code",
        },
      ],
      win32: [
        {
          label: "PowerShell (recommended)",
          command: "irm https://code.kimi.com/kimi-code/install.ps1 | iex",
        },
        {
          label: "npm (Node.js 22.19+)",
          command: "npm install -g @moonshot-ai/kimi-code",
        },
      ],
    },
    platformNotes: {
      win32:
        "Install Git for Windows before first launch; Kimi uses its bundled Git Bash.",
    },
  },
  qwen: {
    name: "Qwen Code",
    description:
      "Qwen's coding agent. Run /auth for ModelStudio, third-party, or custom providers.",
    vendor: "Alibaba Cloud",
    trademarks: "Qwen is a trademark of Alibaba Cloud.",
    docsUrl: "https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/",
    installCommands: {
      darwin: [
        {
          label: "Recommended",
          command:
            "curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash",
        },
        { label: "Homebrew", command: "brew install qwen-code" },
        {
          label: "npm (Node.js 22+)",
          command: "npm install -g @qwen-code/qwen-code@latest",
        },
      ],
      linux: [
        {
          label: "Recommended",
          command:
            "curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash",
        },
        { label: "Homebrew", command: "brew install qwen-code" },
        {
          label: "npm (Node.js 22+)",
          command: "npm install -g @qwen-code/qwen-code@latest",
        },
      ],
      win32: [
        {
          label: "PowerShell (recommended)",
          command:
            "irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex",
        },
        {
          label: "npm (Node.js 22+)",
          command: "npm install -g @qwen-code/qwen-code@latest",
        },
      ],
    },
    platformNotes: {
      darwin: "Qwen OAuth has ended; choose a provider from /auth after launch.",
      linux: "Qwen OAuth has ended; choose a provider from /auth after launch.",
      win32:
        "Restart the terminal after install. Qwen OAuth has ended; use /auth after launch.",
    },
  },
  grok: {
    name: "Grok Build",
    description:
      "xAI's coding agent. The CLI opens browser sign-in on first launch.",
    mark: "grok",
    vendor: "SpaceXAI",
    trademarks: "Grok and the Grok logo are trademarks of SpaceXAI, formerly xAI.",
    docsUrl: "https://docs.x.ai/build/overview",
    installCommands: {
      darwin: [
        {
          label: "Recommended",
          command: "curl -fsSL https://x.ai/cli/install.sh | bash",
        },
      ],
      linux: [
        {
          label: "Recommended",
          command: "curl -fsSL https://x.ai/cli/install.sh | bash",
        },
      ],
      win32: [
        {
          label: "PowerShell",
          command: "irm https://x.ai/cli/install.ps1 | iex",
        },
      ],
    },
  },
};

const ACP_AGENT_IDS: readonly AcpAgentId[] = Object.keys(
  ACP_AGENT_BACKENDS,
) as AcpAgentId[];

const AGENT_BACKEND_IDS: readonly AgentBackendId[] = ["codex", ...ACP_AGENT_IDS];

/** Every id has a definition, so there is no fallback to show in its place. */
function agentBackendDefinition(id: AgentBackendId): AgentBackendDefinition {
  return id === "codex" ? CODEX_BACKEND : ACP_AGENT_BACKENDS[id];
}

export function backendTrademarkNotice(id: AgentBackendId): string {
  const backend = agentBackendDefinition(id);
  return `${backend.trademarks} PwrAgent is independently developed and is not affiliated with, endorsed by, or sponsored by ${backend.vendor}.`;
}

export function installedAgentBackendNames(
  snapshot: DesktopSettingsSnapshot | undefined,
  acpEntries: readonly AcpAgentSettingsEntry[],
): string[] {
  return AGENT_BACKEND_IDS.flatMap((id) => {
    const installed =
      id === "codex"
        ? Boolean(selectedCodexCandidate(snapshot))
        : Boolean(acpEntryFor(acpEntries, id)?.installed);
    const enabled = id === "codex" || acpBackendEnabled(snapshot, id);
    return installed && enabled ? [agentBackendDefinition(id).name] : [];
  });
}

function selectedCodexCandidate(snapshot: DesktopSettingsSnapshot | undefined) {
  return snapshot?.models.codex.discovery.candidates.find(
    (candidate) =>
      candidate.selected
      && candidate.executable
      && Boolean(candidate.version)
      && !candidate.failureReason
      && !candidate.versionFailureReason,
  );
}

function acpEntryFor(
  entries: readonly AcpAgentSettingsEntry[],
  registryId: Exclude<AgentBackendId, "codex">,
): AcpAgentSettingsEntry | undefined {
  return entries.find((entry) => entry.registryId === registryId);
}

function acpBackendEnabled(
  snapshot: DesktopSettingsSnapshot | undefined,
  registryId: Exclude<AgentBackendId, "codex">,
): boolean {
  const agents = snapshot?.acpAgents as
    | Record<string, { enabled?: boolean } | undefined>
    | undefined;
  return agents?.[registryId]?.enabled !== false;
}

export function isBackendRequirementSatisfied(
  snapshot: DesktopSettingsSnapshot | undefined,
  acpEntries: readonly AcpAgentSettingsEntry[],
): boolean {
  return installedAgentBackendNames(snapshot, acpEntries).length > 0;
}


/** The agents the guided flow sets up, in tab order. Claude Code is not
 *  an ACP agent and has no install command list, so it sits beside the
 *  catalogue rather than in it. */
export type AgentTabId = AgentBackendId | "claude";

export const AGENT_TABS: readonly AgentTabId[] = [
  "codex",
  "claude",
  ...ACP_AGENT_IDS,
];

type ClaudeInstallation = BackendSummary["claude"];

const CLAUDE_SETUP_GUIDE_URL = "https://code.claude.com/docs/en/setup";
const CLAUDE_SIGN_IN_COMMAND = "claude auth login";
const CLAUDE_DEFINITION = {
  name: "Claude Code",
  description:
    "Anthropic's coding agent. Sign in with your Claude account after install.",
  trademarks: "Claude and Claude Code are trademarks of Anthropic, PBC.",
  vendor: "Anthropic",
};

export function agentTabName(id: AgentTabId): string {
  if (id === "claude") return CLAUDE_DEFINITION.name;
  return agentBackendDefinition(id).name;
}

function agentTrademarkNotice(id: AgentTabId): string {
  if (id !== "claude") return backendTrademarkNotice(id);
  return `${CLAUDE_DEFINITION.trademarks} PwrAgent is independently developed and is not affiliated with, endorsed by, or sponsored by ${CLAUDE_DEFINITION.vendor}.`;
}

export function agentInstalled(
  id: AgentTabId,
  snapshot: DesktopSettingsSnapshot | undefined,
  acpEntries: readonly AcpAgentSettingsEntry[],
  claude: ClaudeInstallation | undefined,
): boolean {
  if (id === "codex") return Boolean(selectedCodexCandidate(snapshot));
  if (id === "claude") return Boolean(claude?.executable);
  return Boolean(acpEntryFor(acpEntries, id)?.installed);
}

export function agentEnabled(
  id: AgentTabId,
  snapshot: DesktopSettingsSnapshot | undefined,
): boolean {
  if (id === "codex" || id === "claude") return true;
  return acpBackendEnabled(snapshot, id);
}

/** The Codex auth profile this PwrAgent profile signs in with. */
export function activeCodexAuthProfile(
  snapshot: DesktopSettingsSnapshot | undefined,
) {
  const profiles = snapshot?.models.codex.profiles.profiles ?? [];
  return profiles.find((profile) => profile.selected)
    ?? profiles.find((profile) => profile.name === "");
}

/**
 * The agent discovery state the flow shares between its steps. It starts
 * from what Settings already read. `refresh` is the only call that probes
 * provider CLIs, and only a click starts it.
 */
export function useAgentDiscovery(params: {
  settings: DesktopSettingsState;
  desktopApi?: DesktopApi;
  initialAcpEntries?: readonly AcpAgentSettingsEntry[];
  initialBackends?: readonly BackendSummary[];
}) {
  const { desktopApi, settings } = params;
  const [acpEntries, setAcpEntries] = useState<AcpAgentSettingsEntry[]>(
    () => [...(params.initialAcpEntries ?? [])],
  );
  const [claude, setClaude] = useState<ClaudeInstallation | undefined>(
    () => params.initialBackends?.find((backend) => backend.kind === "claude")?.claude,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const cachedReadStarted = useRef(false);

  // The cached catalogue only. `refresh: false` with no discovery intent
  // reads what main already knows and starts no CLI.
  useEffect(() => {
    if (cachedReadStarted.current || !desktopApi?.listAcpAgents) return;
    cachedReadStarted.current = true;
    void desktopApi
      .listAcpAgents({ refresh: false })
      .then((response) => setAcpEntries(response.entries))
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      });
  }, [desktopApi]);

  const readBackends = useCallback(async (): Promise<void> => {
    if (!desktopApi?.listBackends) return;
    const result = await desktopApi.listBackends({ includeUnavailable: true });
    setClaude(
      result.backends.find((backend) => backend.kind === "claude")?.claude,
    );
    window.dispatchEvent(new Event(BACKEND_SUMMARIES_REFRESH_EVENT));
  }, [desktopApi]);

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    setError(undefined);
    try {
      const results = await Promise.allSettled([
        desktopApi?.refreshCodexDiscovery?.({
          discoveryIntent: "setup-user-action",
        }),
        desktopApi?.listAcpAgents?.({
          discoveryIntent: "setup-user-action",
          refresh: true,
          probeCapabilities: false,
        }),
        readBackends(),
      ]);
      const codexResult = results[0];
      if (
        codexResult?.status === "fulfilled"
        && codexResult.value
        && settings.applySnapshot
      ) {
        settings.applySnapshot(codexResult.value.snapshot);
      } else {
        await settings.refresh();
      }
      const acpResult = results[1];
      if (acpResult?.status === "fulfilled" && acpResult.value) {
        setAcpEntries(acpResult.value.entries);
        window.dispatchEvent(new Event(BACKEND_SUMMARIES_REFRESH_EVENT));
        if (acpResult.value.error) setError(acpResult.value.error);
      }
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [String(result.reason)] : [],
      );
      if (failures.length > 0) setError(failures.join("; "));
    } finally {
      setRefreshing(false);
    }
  }, [desktopApi, readBackends, refreshing, settings]);

  return {
    acpEntries,
    setAcpEntries,
    claude,
    readBackends,
    refresh,
    refreshing,
    error,
    setError,
  };
}

export type AgentDiscovery = ReturnType<typeof useAgentDiscovery>;

/* ----------------------------------------------------------------
   Step 1 — pick an agent, install it, turn it on
   ---------------------------------------------------------------- */

export function AgentChooseStep(props: {
  settings: DesktopSettingsState;
  desktopApi?: DesktopApi;
  discovery: AgentDiscovery;
  active: AgentTabId;
  onActiveChange: (id: AgentTabId) => void;
}) {
  const [copiedCommand, setCopiedCommand] = useState<string>();
  const [optimisticEnabled, setOptimisticEnabled] = useState<
    Partial<Record<Exclude<AgentBackendId, "codex">, boolean>>
  >({});
  const { discovery } = props;
  const snapshot = props.settings.snapshot;
  const codexDiscovery = snapshot?.models.codex.discovery;
  const codexCandidate = selectedCodexCandidate(snapshot);
  const platform = agentDesktopPlatform(props.desktopApi?.platform);
  const active = props.active;

  const installed = (id: AgentTabId): boolean =>
    agentInstalled(id, snapshot, discovery.acpEntries, discovery.claude);
  const activeDefinition =
    active === "claude"
      ? undefined
      : agentBackendDefinition(active);
  const activeAcpEntry =
    active === "codex" || active === "claude"
      ? undefined
      : acpEntryFor(discovery.acpEntries, active);
  const activeAcpEnabled =
    active === "codex" || active === "claude"
      ? true
      : optimisticEnabled[active] ?? acpBackendEnabled(snapshot, active);
  const activeCommand =
    active === "codex"
      ? codexCandidate?.command
      : active === "claude"
        ? discovery.claude?.executable
        : activeAcpEntry?.activeCommand;
  const activeVersion =
    active === "codex"
      ? codexCandidate?.version
      : active === "claude"
        ? discovery.claude?.version
        : activeAcpEntry?.version;

  const setActiveAcpEnabled = async (enabled: boolean): Promise<void> => {
    if (active === "codex" || active === "claude") return;
    discovery.setError(undefined);
    const saved = await props.settings.writeConfig({
      acpAgents: { [active]: { enabled } } as NonNullable<
        DesktopSettingsConfigPatch["acpAgents"]
      >,
    });
    if (!saved) return;
    setOptimisticEnabled((current) => ({ ...current, [active]: enabled }));
  };

  const name = agentTabName(active);
  const description = activeDefinition?.description ?? CLAUDE_DEFINITION.description;
  const mark: SetupMarkId = activeDefinition?.mark ?? "cli";

  return (
    <div className="guided-setup__prereqs">
      <header className="guided-setup__head">
        <h1 className="guided-setup__title">Pick an agent to set up</h1>
        <p className="guided-setup__sub">
          PwrAgent connects to agent CLIs installed on this computer. Pick one,
          install it if it isn&rsquo;t found, then refresh discovery.
        </p>
      </header>

      <div
        className="guided-setup__backend-tabs"
        role="tablist"
        aria-label="Agents"
      >
        {AGENT_TABS.map((id) => {
          const found = installed(id);
          return (
            <button
              key={id}
              id={`guided-agent-tab-${id}`}
              type="button"
              role="tab"
              aria-controls="guided-agent-panel"
              aria-selected={active === id}
              className={`guided-setup__backend-tab${active === id ? " is-active" : ""}`}
              onClick={() => props.onActiveChange(id)}
            >
              <span>{agentTabName(id)}</span>
              <span
                className={`guided-setup__backend-tab-dot${found ? " is-installed" : ""}`}
                aria-label={found ? "Installed" : "Not found"}
              />
            </button>
          );
        })}
      </div>

      <div
        id="guided-agent-panel"
        className="guided-setup__prereq-card"
        role="tabpanel"
        aria-labelledby={`guided-agent-tab-${active}`}
      >
        <div className="guided-setup__prereq-head">
          <div className="guided-setup__prereq-identity">
            <SetupMark mark={mark} className="guided-setup__prereq-mark" />
            <div>
              <div className="guided-setup__prereq-title">{name}</div>
              <div className="guided-setup__prereq-sub">{description}</div>
            </div>
          </div>
          <span
            className={`guided-setup__prereq-status ${
              installed(active)
                ? "guided-setup__prereq-status--ok"
                : "guided-setup__prereq-status--missing"
            }`}
          >
            {installed(active)
              ? `✓ Found${activeVersion ? ` v${activeVersion}` : ""}`
              : active === "claude" && !discovery.claude
                ? "Not checked"
                : "Not found"}
          </span>
        </div>

        {activeCommand ? (
          <div className="guided-setup__prereq-detail">
            <code>{activeCommand}</code>
          </div>
        ) : active === "codex" ? (
          <div className="guided-setup__prereq-detail">
            <details className="guided-setup__prereq-paths">
              <summary>
                Checked PATH and common install locations — no usable Codex
                CLI found
              </summary>
              {codexDiscovery?.candidates.length ? (
                <ul>
                  {codexDiscovery.candidates.map((candidate) => (
                    <li key={candidate.command}>
                      <code>{candidate.command}</code>
                      <span className="guided-setup__prereq-paths-reason">
                        {candidate.failureReason
                          ?? candidate.versionFailureReason
                          ?? "not executable"}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>
                  PwrAgent checks PATH and common{" "}
                  {agentPlatformLabel(platform)} install locations. If you
                  just installed Codex, refresh discovery after the installer
                  finishes.
                </p>
              )}
            </details>
          </div>
        ) : null}

        {activeDefinition ? (
          <div className="guided-setup__prereq-install">
            <strong>
              Install or update {activeDefinition.name} on{" "}
              {agentPlatformLabel(platform)}:
            </strong>
            <ul>
              {activeDefinition.installCommands[platform].map((install) => (
                <li key={install.command}>
                  {install.label}: <code>{install.command}</code>
                  {props.desktopApi?.copyText ? (
                    <button
                      type="button"
                      className="guided-setup__btn guided-setup__btn--microlink"
                      aria-label={`Copy ${install.label} command`}
                      onClick={() => {
                        setCopiedCommand(undefined);
                        void props.desktopApi?.copyText?.(install.command).then(
                          () => setCopiedCommand(install.command),
                          () => discovery.setError(
                            "Could not copy the command. Select and copy it manually.",
                          ),
                        );
                      }}
                    >
                      {copiedCommand === install.command ? "Copied" : "Copy"}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            {activeDefinition.platformNotes?.[platform] ? (
              <p className="guided-setup__prereq-install-note">
                {activeDefinition.platformNotes[platform]}
              </p>
            ) : null}
            <a href={activeDefinition.docsUrl} target="_blank" rel="noreferrer">
              Open official setup guide ↗
            </a>
          </div>
        ) : (
          <div className="guided-setup__prereq-install">
            <strong>
              Install Claude Code on {agentPlatformLabel(platform)} with
              Anthropic&rsquo;s guide.
            </strong>
            <p className="guided-setup__prereq-install-note">
              PwrAgent also ships a copy it uses when yours is missing or
              older.
            </p>
            <a href={CLAUDE_SETUP_GUIDE_URL} target="_blank" rel="noreferrer">
              Open official setup guide ↗
            </a>
          </div>
        )}

        <div className="guided-setup__prereq-actions">
          {active !== "codex" && active !== "claude" ? (
            <div className="guided-setup__prereq-enable">
              <SettingsSwitch
                checked={activeAcpEnabled}
                disabled={props.settings.saving}
                label={`Enable ${name}`}
                onChange={(enabled) => {
                  void setActiveAcpEnabled(enabled);
                }}
              />
              <span>Enable {name}</span>
            </div>
          ) : null}
          <button
            type="button"
            className="guided-setup__btn guided-setup__btn--ghost"
            disabled={discovery.refreshing}
            onClick={() => void discovery.refresh()}
          >
            {discovery.refreshing
              ? "Refreshing all agents…"
              : "Refresh after install"}
          </button>
          {discovery.error ? (
            <span className="guided-setup__prereq-error" role="status">
              {discovery.error}
            </span>
          ) : null}
        </div>
      </div>
      <p className="guided-setup__trademark-note">
        {agentTrademarkNotice(active)}
      </p>
    </div>
  );
}

/* ----------------------------------------------------------------
   Step 2 — sign in to the agent picked in step 1
   ---------------------------------------------------------------- */

export function AgentSignInStep(props: {
  settings: DesktopSettingsState;
  desktopApi?: DesktopApi;
  discovery: AgentDiscovery;
  active: AgentTabId;
  claudeSignIn?: ClaudeSignInControls;
}) {
  const name = agentTabName(props.active);
  return (
    <div>
      <header className="guided-setup__head">
        <h1 className="guided-setup__title">Sign in to {name}</h1>
        <p className="guided-setup__sub">
          {props.active === "codex"
            ? "Codex signs in through your browser. Focus the browser window that is already signed in to the right account first, or copy the login link into the browser you want."
            : props.active === "claude"
              ? "Claude Code signs in through your browser, or from your terminal."
              : props.active === "gemini"
                ? "Gemini CLI opens Google sign-in the first time PwrAgent starts it."
                : "This agent signs in from its own CLI the first time you run it."}
        </p>
      </header>
      {props.active === "codex" ? (
        <CodexSignIn settings={props.settings} desktopApi={props.desktopApi} />
      ) : props.active === "claude" ? (
        <ClaudeSignIn
          desktopApi={props.desktopApi}
          discovery={props.discovery}
          claudeSignIn={props.claudeSignIn}
        />
      ) : props.active === "gemini" ? (
        <GeminiSignIn desktopApi={props.desktopApi} discovery={props.discovery} />
      ) : (
        <CliSignInNote active={props.active} />
      )}
    </div>
  );
}

function CodexSignIn(props: {
  settings: DesktopSettingsState;
  desktopApi?: DesktopApi;
}) {
  const authProfile = activeCodexAuthProfile(props.settings.snapshot);
  const profileName = authProfile?.name ?? "";
  // The snapshot's auth-file flag is what Settings already knows. A real
  // check runs `codex login status`, so it waits for the operator.
  const initial: RowLoginState =
    authProfile?.hasAuthFile && !authProfile.authenticationRequired
      ? { kind: "ok", email: authProfile.accountEmail }
      : { kind: "idle" };
  const login = useCodexProfileLogin(props.desktopApi, profileName, initial);
  return (
    <div className="guided-setup__profile-list">
      <CodexLoginRow
        label={profileName === "" ? "System default" : authProfile?.displayName ?? profileName}
        meta={authProfile?.codexHome}
        marker="↻"
        login={login}
      />
    </div>
  );
}

function ClaudeSignIn(props: {
  desktopApi?: DesktopApi;
  discovery: AgentDiscovery;
  claudeSignIn?: ClaudeSignInControls;
}) {
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);
  const installation = props.discovery.claude;
  const status = claudeProviderStatus(installation);
  const signedIn = installation?.authStatus === "signed-in";
  const command = installation?.loginCommand ?? CLAUDE_SIGN_IN_COMMAND;
  if (installation && !installation.executable) {
    return (
      <p className="guided-setup__notice" role="status">
        Claude Code isn&rsquo;t installed yet. Go back to install it, then
        refresh discovery.
      </p>
    );
  }
  return (
    <div className="guided-setup__profile-list">
      <div className={`guided-setup__profile-row guided-setup__profile-row--has-login is-${signedIn ? "ok" : "idle"}`}>
        <div className="guided-setup__profile-row-top">
          <span className="guided-setup__profile-num">C</span>
          <span className="guided-setup__profile-input guided-setup__profile-input--static">
            <code>Claude Code</code>
            <span className="guided-setup__profile-input-meta">{status.label}</span>
          </span>
          <div className="guided-setup__profile-row-actions">
            {!signedIn && props.claudeSignIn?.onSignIn ? (
              <button
                type="button"
                className="guided-setup__btn guided-setup__btn--ghost"
                disabled={props.claudeSignIn.signingIn}
                onClick={props.claudeSignIn.onSignIn}
              >
                {props.claudeSignIn.signingIn
                  ? "Waiting for Claude sign-in…"
                  : "Sign in to Claude"}
              </button>
            ) : null}
            {signedIn ? (
              <span className="guided-setup__profile-row-status guided-setup__profile-row-status--ok">
                ✓ Signed in
              </span>
            ) : (
              <button
                type="button"
                className="guided-setup__btn guided-setup__btn--link"
                disabled={checking}
                onClick={() => {
                  setChecking(true);
                  void props.discovery
                    .readBackends()
                    .catch((caught: unknown) => {
                      props.discovery.setError(
                        caught instanceof Error ? caught.message : String(caught),
                      );
                    })
                    .finally(() => setChecking(false));
                }}
              >
                {checking ? "Checking…" : "Check status"}
              </button>
            )}
          </div>
        </div>
        {!signedIn ? (
          <div className="guided-setup__profile-row-detail">
            Or run <code>{command}</code> in your terminal
            {props.desktopApi?.copyText ? (
              <>
                {" "}
                <button
                  type="button"
                  className="guided-setup__btn guided-setup__btn--microlink"
                  aria-label="Copy Claude sign-in command"
                  onClick={() => {
                    void props.desktopApi?.copyText?.(command).then(
                      () => setCopied(true),
                      () => setCopied(false),
                    );
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </>
            ) : null}
            , then check status.
          </div>
        ) : null}
      </div>
      {props.discovery.error ? (
        <span className="guided-setup__prereq-error" role="status">
          {props.discovery.error}
        </span>
      ) : null}
    </div>
  );
}

function GeminiSignIn(props: {
  desktopApi?: DesktopApi;
  discovery: AgentDiscovery;
}) {
  const [state, setState] = useState<"idle" | "running" | "ready">("idle");
  const { discovery } = props;
  const gemini = acpEntryFor(discovery.acpEntries, "gemini");
  const loginToGemini = async (): Promise<void> => {
    if (!props.desktopApi?.listAcpAgents) {
      discovery.setError("Gemini login is unavailable in this build.");
      return;
    }
    discovery.setError(undefined);
    setState("running");
    try {
      const response = await props.desktopApi.listAcpAgents({
        discoveryIntent: "setup-user-action",
        refresh: true,
        force: true,
        registryIds: ["gemini"],
      });
      discovery.setAcpEntries(response.entries);
      window.dispatchEvent(new Event(BACKEND_SUMMARIES_REFRESH_EVENT));
      const next = acpEntryFor(response.entries, "gemini");
      const loginError =
        next?.lastDiscoveryError
        ?? (!next?.installed ? "Gemini CLI could not be started." : undefined);
      if (loginError) {
        discovery.setError(loginError);
        setState("idle");
        return;
      }
      setState("ready");
    } catch (caught: unknown) {
      discovery.setError(caught instanceof Error ? caught.message : String(caught));
      setState("idle");
    }
  };
  if (!gemini?.installed) {
    return (
      <p className="guided-setup__notice" role="status">
        Gemini CLI isn&rsquo;t installed yet. Go back to install it, then
        refresh discovery.
      </p>
    );
  }
  return (
    <div className="guided-setup__prereq-actions">
      <button
        type="button"
        className="guided-setup__btn guided-setup__btn--primary"
        disabled={state === "running"}
        onClick={() => void loginToGemini()}
      >
        {state === "running"
          ? "Waiting for Gemini login…"
          : state === "ready"
            ? "Gemini CLI ready"
            : "Log in to Gemini CLI"}
      </button>
      {discovery.error ? (
        <span className="guided-setup__prereq-error" role="status">
          {discovery.error}
        </span>
      ) : null}
    </div>
  );
}

function CliSignInNote(props: { active: Exclude<AgentBackendId, "codex" | "gemini"> }) {
  const definition = agentBackendDefinition(props.active);
  return (
    <div className="guided-setup__prereq-card">
      <div className="guided-setup__prereq-sub">{definition.description}</div>
      <a href={definition.docsUrl} target="_blank" rel="noreferrer">
        Open official setup guide ↗
      </a>
    </div>
  );
}

/* ----------------------------------------------------------------
   Step 3 — review
   ---------------------------------------------------------------- */

export function AgentReviewStep(props: {
  settings: DesktopSettingsState;
  discovery: AgentDiscovery;
  onSetUpAnother: () => void;
}) {
  const snapshot = props.settings.snapshot;
  const rows = AGENT_TABS.map((id) => {
    const found = agentInstalled(
      id,
      snapshot,
      props.discovery.acpEntries,
      props.discovery.claude,
    );
    const on = agentEnabled(id, snapshot);
    const actionRequired = id !== "codex" && id !== "claude"
      && Boolean(acpEntryFor(props.discovery.acpEntries, id)?.unavailableReason);
    const ready = found && on && !actionRequired;
    const label = !found ? "Not installed" : !on ? "Turned off" : actionRequired ? "Action required" : "Ready";
    return { id, name: agentTabName(id), ready, label };
  });
  const ready = rows.filter((row) => row.ready);
  return (
    <ReviewSummary
      title={
        ready.length > 0
          ? `${ready.length} agent${ready.length === 1 ? "" : "s"} ready`
          : "No agents ready yet"
      }
      sub="Change paths, models, and sign-in later from Settings → AI providers."
      rows={rows.map((row) => ({
        key: row.id,
        label: row.name,
        value: row.label,
      }))}
    >
      <button
        type="button"
        className="guided-setup__btn guided-setup__btn--ghost"
        onClick={props.onSetUpAnother}
      >
        Set up another agent
      </button>
    </ReviewSummary>
  );
}
