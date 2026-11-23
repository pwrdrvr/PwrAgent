import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpAgentSettingsEntry, BackendSummary } from "@pwragent/shared/contracts/backend";
import type {
  DesktopBootInfo,
  DesktopSettingsSnapshot,
  DiscoverRecentProjectsRequest,
  DiscoverRecentProjectsResponse,
  RecentProjectDiscoveryPart,
} from "@pwragent/shared/contracts/settings";
import type { DesktopApi } from "../../../lib/desktop-api";
import type { ClaudeSignInControls } from "../../notifications/useClaudeSignIn";
import type { DesktopSettingsState } from "../../settings/useDesktopSettings";
import { GetStarted } from "../GetStarted";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function snapshot(codexInstalled: boolean): DesktopSettingsSnapshot {
  return {
    models: {
      codex: {
        discovery: {
          candidates: codexInstalled
            ? [{
                command: "/usr/local/bin/codex",
                source: "path",
                executable: true,
                selected: true,
                version: "0.126.0",
              }]
            : [],
        },
      },
    },
  } as unknown as DesktopSettingsSnapshot;
}

function acpEntry(registryId: "gemini" | "kimi" | "qwen" | "grok", installed = true): AcpAgentSettingsEntry {
  return {
    backendId: `acp:${registryId}`,
    registryId,
    name: registryId,
    authors: [],
    distributionKind: "local",
    distributionSource: registryId,
    installable: false,
    installed,
    installStatus: installed ? "installed" : "not-installed",
    authStatus: "not-required",
    verificationStatus: "not-applicable",
    instances: [],
  };
}

const claudeSignedIn: BackendSummary = {
  kind: "claude",
  label: "Claude Code",
  available: true,
  claude: { executable: "/usr/local/bin/claude", source: "system", authStatus: "signed-in" },
} as BackendSummary;

function settingsState(codexInstalled: boolean) {
  return {
    snapshot: snapshot(codexInstalled),
    saving: false,
    refresh: vi.fn(async () => undefined),
    applySnapshot: vi.fn(),
    writeConfig: vi.fn(async () => true),
  } as unknown as DesktopSettingsState & { writeConfig: ReturnType<typeof vi.fn> };
}

function api(overrides: Partial<DesktopApi> & { authenticated?: boolean; backends?: BackendSummary[] } = {}) {
  const { authenticated = true, backends = [], ...rest } = overrides;
  return {
    platform: "darwin",
    refreshCodexDiscovery: vi.fn(async () => ({ snapshot: snapshot(true) })),
    listAcpAgents: vi.fn(async () => ({ fetchedAt: 1, entries: [acpEntry("gemini", false), acpEntry("qwen", false)] })),
    listBackends: vi.fn(async () => ({ fetchedAt: 1, backends })),
    checkCodexAuthProfileStatus: vi.fn(async () => ({
      profile: "",
      authenticated,
      ...(authenticated ? { email: "sam@example.com", planType: "plus" } : { detail: "Not logged in" }),
    })),
    startCodexAuthProfileLogin: vi.fn(async () => ({
      profile: "",
      authenticated: false,
      loginUrl: "https://auth.example.com/login",
    })),
    copyText: vi.fn(async () => undefined),
    createPwrAgentProfile: vi.fn(async () => ({})),
    createCodexAuthProfile: vi.fn(async () => ({})),
    setPwrAgentProfileCodexProfile: vi.fn(async () => ({})),
    graduateBootstrapConfigToProfile: vi.fn(async () => ({})),
    openPwrAgentProfile: vi.fn(async () => ({})),
    waitForProfileAlive: vi.fn(async () => ({ profile: "default", alive: false, waitedMs: 0 })),
    shutdownMessagingRuntime: vi.fn(async () => undefined),
    quitApp: vi.fn(async () => undefined),
    ...rest,
  } as unknown as DesktopApi & Record<string, ReturnType<typeof vi.fn>>;
}

const firstRun: DesktopBootInfo = { mode: "bootstrap", decisionKind: "no-profile-configured" };

function renderGetStarted(params: {
  desktopApi: ReturnType<typeof api>;
  settings?: ReturnType<typeof settingsState>;
  bootInfo?: DesktopBootInfo | null;
  isReplay?: boolean;
  claudeSignIn?: ClaudeSignInControls;
}) {
  const settings = params.settings ?? settingsState(true);
  const onComplete = vi.fn(async () => undefined);
  const onDismiss = vi.fn();
  const element = (claudeSignIn?: ClaudeSignInControls) => (
    <GetStarted
      isReplay={params.isReplay ?? false}
      bootInfo={params.bootInfo === undefined ? firstRun : params.bootInfo}
      settings={settings}
      desktopApi={params.desktopApi}
      claudeSignIn={claudeSignIn}
      onComplete={onComplete}
      onDismiss={onDismiss}
    />
  );
  const view = render(element(params.claudeSignIn));
  return {
    settings,
    onComplete,
    onDismiss,
    setClaudeSignIn: (claudeSignIn?: ClaudeSignInControls) => view.rerender(element(claudeSignIn)),
  };
}

function agentRow(name: string): HTMLElement {
  return screen.getByText(name, { selector: ".get-started__agent-name" }).closest("li") as HTMLElement;
}

describe("Get started", () => {
  it("checks every agent with setup permission as it opens, and launches no agent's sign-in", async () => {
    const desktopApi = api();
    renderGetStarted({ desktopApi });
    await waitFor(() => {
      expect(desktopApi.refreshCodexDiscovery).toHaveBeenCalledWith({ discoveryIntent: "setup-user-action" });
      expect(desktopApi.listAcpAgents).toHaveBeenCalledWith({
        discoveryIntent: "setup-user-action",
        refresh: true,
        probeCapabilities: false,
      });
    });
    expect(desktopApi.listAcpAgents).not.toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    expect(desktopApi.startCodexAuthProfileLogin).not.toHaveBeenCalled();
  });

  it("finds the Claude Code CLI that ships with PwrAgent instead of offering Install", async () => {
    // The owner's Claude summary names no executable until Claude discovery
    // runs; only a discovery request finds the bundled CLI.
    const undiscovered = {
      kind: "claude",
      label: "Claude Code",
      available: false,
      claude: { authStatus: "unknown" },
    } as BackendSummary;
    const bundled = {
      kind: "claude",
      label: "Claude Code",
      available: false,
      claude: { executable: "/Applications/PwrAgent.app/claude", source: "bundled", authStatus: "sign-in-required" },
    } as BackendSummary;
    const desktopApi = api({
      listBackends: vi.fn(async (request?: { refreshModels?: unknown; discoveryIntent?: unknown }) => ({
        fetchedAt: 1,
        backends: [
          request?.refreshModels === "claude" && request.discoveryIntent === "setup-user-action"
            ? bundled
            : undiscovered,
        ],
      })),
    } as Partial<DesktopApi>);
    renderGetStarted({ desktopApi });
    await screen.findByRole("button", { name: "Check again" });
    const claude = agentRow("Claude Code");
    expect(within(claude).getByText("Needs sign-in")).toBeInTheDocument();
    expect(within(claude).queryByRole("button", { name: "Install" })).not.toBeInTheDocument();
  });

  it("gives the bundled CLI's own sign-in command when it can't sign in from here", async () => {
    const loginCommand = "'/Applications/PwrAgent.app/claude' auth login";
    const desktopApi = api({
      backends: [{
        kind: "claude",
        label: "Claude Code",
        available: false,
        claude: { executable: "/Applications/PwrAgent.app/claude", source: "bundled", loginCommand, authStatus: "sign-in-required" },
      } as BackendSummary],
    });
    renderGetStarted({ desktopApi });
    await screen.findByRole("button", { name: "Check again" });
    fireEvent.click(within(agentRow("Claude Code")).getByRole("button", { name: "Sign in" }));
    expect(within(agentRow("Claude Code")).getByText(loginCommand)).toBeInTheDocument();
    expect(within(agentRow("Claude Code")).queryByText("claude auth login")).not.toBeInTheDocument();
  });

  it("checks again when an in-app Claude Code sign-in ends", async () => {
    const desktopApi = api({ authenticated: false });
    const { setClaudeSignIn } = renderGetStarted({
      desktopApi,
      claudeSignIn: { onSignIn: () => undefined, signingIn: false },
    });
    await screen.findByRole("button", { name: "Check again" });
    expect(desktopApi.listBackends).toHaveBeenCalledOnce();
    setClaudeSignIn({ onSignIn: () => undefined, signingIn: true });
    expect(desktopApi.listBackends).toHaveBeenCalledOnce();
    setClaudeSignIn({ onSignIn: () => undefined, signingIn: false });
    await waitFor(() => expect(desktopApi.listBackends).toHaveBeenCalledTimes(2));
    await screen.findByRole("button", { name: "Check again" });
  });

  it("says why Start failed instead of silently staying put", async () => {
    vi.stubEnv("DEV", false);
    const desktopApi = api({
      createPwrAgentProfile: vi.fn(async () => { throw new Error("A profile named default already exists."); }),
    } as Partial<DesktopApi>);
    renderGetStarted({ desktopApi });
    await screen.findByRole("button", { name: "Check again" });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A profile named default already exists.");
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
  });

  it("enables Start once one agent is ready, and lists every ready agent", async () => {
    const desktopApi = api({ backends: [claudeSignedIn] });
    renderGetStarted({ desktopApi });
    expect(await screen.findByRole("heading", { name: "Your agents are ready." })).toBeInTheDocument();
    expect(within(agentRow("Codex")).getByText("Ready")).toBeInTheDocument();
    expect(within(agentRow("Codex")).getByText("sam@example.com · plus")).toBeInTheDocument();
    expect(within(agentRow("Claude Code")).getByText("Ready")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
  });

  it("keeps Start off, with its reason, until an agent is ready", async () => {
    const desktopApi = api({
      authenticated: false,
      refreshCodexDiscovery: vi.fn(async () => ({ snapshot: snapshot(false) })),
    });
    renderGetStarted({ desktopApi, settings: settingsState(false) });
    expect(await screen.findByRole("heading", { name: "Set up an agent to start." })).toBeInTheDocument();
    await waitFor(() => expect(within(agentRow("Codex")).getByText("Not installed")).toBeInTheDocument());
    const start = screen.getByRole("button", { name: "Start" });
    expect(start).toBeDisabled();
    expect(start).toHaveAccessibleDescription("Set up one agent to start.");
  });

  it("shows install commands for this platform only when asked, with Copy", async () => {
    const desktopApi = api({ platform: "linux" } as Partial<DesktopApi>);
    renderGetStarted({ desktopApi, settings: settingsState(false) });
    const codex = agentRow("Codex");
    await waitFor(() => expect(within(codex).getByText("Not installed")).toBeInTheDocument());
    expect(within(codex).queryByText(/install\.sh/)).not.toBeInTheDocument();
    fireEvent.click(within(codex).getByRole("button", { name: "Install" }));
    expect(within(codex).getByText("curl -fsSL https://chatgpt.com/codex/install.sh | sh")).toBeInTheDocument();
    expect(within(codex).queryByText("brew install --cask codex")).not.toBeInTheDocument();
    fireEvent.click(within(codex).getByRole("button", { name: "Copy npm command" }));
    await waitFor(() => expect(desktopApi.copyText).toHaveBeenCalledWith("npm install -g @openai/codex"));
  });

  it("signs in to this computer's Codex only on a click, and can cancel and try again", async () => {
    const desktopApi = api({ authenticated: false });
    renderGetStarted({ desktopApi });
    const codex = agentRow("Codex");
    await waitFor(() => expect(within(codex).getByText("Needs sign-in")).toBeInTheDocument());
    expect(desktopApi.startCodexAuthProfileLogin).not.toHaveBeenCalled();

    fireEvent.click(within(codex).getByRole("button", { name: "Sign in with ChatGPT" }));
    await waitFor(() => expect(within(codex).getByRole("button", { name: "Open again" })).toBeInTheDocument());
    expect(desktopApi.startCodexAuthProfileLogin).toHaveBeenCalledWith({ profile: "" });
    fireEvent.click(within(codex).getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(desktopApi.copyText).toHaveBeenCalledWith("https://auth.example.com/login"));

    fireEvent.click(within(codex).getByRole("button", { name: "Cancel" }));
    expect(within(codex).getByText("Sign-in didn't finish. Nothing changed.")).toBeInTheDocument();
    expect(within(codex).getByRole("button", { name: "Try again" })).toBeInTheDocument();

    // A later check that still finds no login keeps the cancelled row.
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await screen.findByRole("button", { name: "Check again" });
    await waitFor(() => expect(desktopApi.checkCodexAuthProfileStatus).toHaveBeenCalledTimes(2));
    expect(within(agentRow("Codex")).getByText("Sign-in didn't finish. Nothing changed.")).toBeInTheDocument();
    expect(within(agentRow("Codex")).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("reports both discovery failures, not only the last", async () => {
    const desktopApi = api({
      refreshCodexDiscovery: vi.fn(async () => { throw new Error("Codex discovery failed"); }),
      listAcpAgents: vi.fn(async () => { throw new Error("ACP discovery failed"); }),
    } as Partial<DesktopApi>);
    renderGetStarted({ desktopApi });
    const status = await screen.findByText(/discovery failed/);
    expect(status).toHaveTextContent("Codex discovery failed");
    expect(status).toHaveTextContent("ACP discovery failed");
  });

  it("turns on an installed agent that is off, through its own setting", async () => {
    const desktopApi = api({
      listAcpAgents: vi.fn(async () => ({ fetchedAt: 1, entries: [acpEntry("qwen")] })),
    } as Partial<DesktopApi>);
    const settings = settingsState(true);
    (settings.snapshot as unknown as { acpAgents: unknown }).acpAgents = { qwen: { enabled: false } };
    renderGetStarted({ desktopApi, settings });
    const qwen = await waitFor(() => agentRow("Qwen Code"));
    fireEvent.click(within(qwen).getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(settings.writeConfig).toHaveBeenCalledWith({ acpAgents: { qwen: { enabled: true } } }));
    await waitFor(() => expect(within(agentRow("Qwen Code")).getByText("Ready")).toBeInTheDocument());
  });

  it("creates the default profile on this computer's Codex login and opens it on Start", async () => {
    // A packaged build opens the new profile; dev mode can only quit.
    vi.stubEnv("DEV", false);
    const desktopApi = api();
    const { settings, onComplete } = renderGetStarted({ desktopApi });
    fireEvent.click(await screen.findByRole("button", { name: "Start" }, { timeout: 2000 }));
    await waitFor(() => expect(desktopApi.openPwrAgentProfile).toHaveBeenCalledWith({ profile: "default" }));
    expect(settings.writeConfig).toHaveBeenCalledWith({ general: { codexProfileModel: "shared" } });
    expect(desktopApi.createPwrAgentProfile).toHaveBeenCalledWith({ profile: "default", seedOnboardingCompleted: true });
    expect(desktopApi.createCodexAuthProfile).not.toHaveBeenCalled();
    expect(desktopApi.graduateBootstrapConfigToProfile).toHaveBeenCalledWith({ targetProfile: "default" });
    // The new window never reported alive, so this one stays open, with
    // the page closed over it: the profile exists, so Start can't run again.
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(desktopApi.quitApp).not.toHaveBeenCalled();
  });

  it("leaves the page up while a bootstrap window that handed off quits", async () => {
    vi.stubEnv("DEV", false);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const desktopApi = api({
        waitForProfileAlive: vi.fn(async () => ({ profile: "default", alive: true, waitedMs: 5 })),
      } as Partial<DesktopApi>);
      const { onComplete } = renderGetStarted({ desktopApi });
      await screen.findByRole("button", { name: "Check again" });
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
      await waitFor(() => expect(desktopApi.waitForProfileAlive).toHaveBeenCalled());
      // The grace period for the new window to paint.
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      await waitFor(() => expect(desktopApi.quitApp).toHaveBeenCalledOnce());
      expect(onComplete).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("confirms a profile the launch named, then gives it its own Codex login by default", async () => {
    vi.stubEnv("DEV", false);
    const desktopApi = api();
    renderGetStarted({
      desktopApi,
      bootInfo: { mode: "bootstrap", decisionKind: "missing-named-profile", requestedProfileName: "work" },
    });
    expect(screen.getByRole("heading", { name: "Set up work?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Set up work" }));
    expect(screen.getByRole("radio", { name: /A separate Codex login/ })).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(within(agentRow("Codex")).getByText("Sign in after setup, in the new profile")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(desktopApi.openPwrAgentProfile).toHaveBeenCalledWith({ profile: "work" }));
    expect(desktopApi.createCodexAuthProfile).toHaveBeenCalledWith({ profile: "work" });
  });

  it("only closes on Done when replayed, creating no profile", async () => {
    const desktopApi = api();
    const { onComplete } = renderGetStarted({
      desktopApi,
      isReplay: true,
      bootInfo: { mode: "active-profile", decisionKind: "open", activeProfileName: "default" },
    });
    // Done stays disabled until the first agent check finds a ready agent.
    const done = await screen.findByRole("button", { name: "Done" });
    await waitFor(() => expect(done).toBeEnabled());
    fireEvent.click(done);
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(desktopApi.createPwrAgentProfile).not.toHaveBeenCalled();
    expect(desktopApi.openPwrAgentProfile).not.toHaveBeenCalled();
  });

  it("asks before skipping first run, starting on the choice that changes nothing", async () => {
    const desktopApi = api();
    const { onDismiss } = renderGetStarted({ desktopApi });
    await screen.findByRole("button", { name: "Check again" });
    fireEvent.click(screen.getByRole("button", { name: "Close setup" }));
    const dialog = screen.getByRole("dialog", { name: "Skip setup?" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Back to setup" })).toHaveFocus());
    fireEvent.click(within(dialog).getByRole("button", { name: "Back to setup" }));
    expect(screen.queryByRole("dialog", { name: "Skip setup?" })).not.toBeInTheDocument();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("rechecks agents on window focus only while nothing is ready or after a setup step opens", async () => {
    let focus: () => void = () => undefined;
    const desktopApi = api({
      onWindowFocus: vi.fn((listener: () => void) => {
        focus = listener;
        return () => undefined;
      }),
    } as Partial<DesktopApi>);
    renderGetStarted({ desktopApi });
    await waitFor(() => expect(screen.getByRole("button", { name: "Start" })).toBeEnabled());
    expect(desktopApi.listAcpAgents).toHaveBeenCalledOnce();
    await screen.findByRole("button", { name: "Check again" });
    // Codex is ready; Claude Code is not installed and nobody asked about it.
    await act(async () => { focus(); });
    expect(desktopApi.listAcpAgents).toHaveBeenCalledOnce();
    fireEvent.click(within(agentRow("Claude Code")).getByRole("button", { name: "Install" }));
    await act(async () => { focus(); });
    await waitFor(() => expect(desktopApi.listAcpAgents).toHaveBeenCalledTimes(2));
    await screen.findByRole("button", { name: "Check again" });
  });

  it("names the Codex login a skipped named profile gets, even before its choice is shown", async () => {
    const desktopApi = api();
    renderGetStarted({
      desktopApi,
      bootInfo: { mode: "bootstrap", decisionKind: "missing-named-profile", requestedProfileName: "work" },
    });
    // Still on the name confirmation, which hides the login choice.
    fireEvent.click(screen.getByRole("button", { name: "Close setup" }));
    const dialog = screen.getByRole("dialog", { name: "Skip setup?" });
    expect(dialog).toHaveTextContent("with its own Codex login, which you sign in to after setup.");
    expect(dialog).not.toHaveTextContent("the Codex login you chose");
    await screen.findByRole("button", { name: "Back to setup" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Back to setup" }));
    await screen.findByRole("button", { name: "Set up work" });
  });

  it("closes a replay on Escape", async () => {
    const desktopApi = api();
    const { onDismiss } = renderGetStarted({
      desktopApi,
      isReplay: true,
      bootInfo: { mode: "active-profile", decisionKind: "open", activeProfileName: "default" },
    });
    await screen.findByRole("button", { name: "Check again" });
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Get started" }), { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledWith(false);
  });
});

describe("Get started projects", () => {
  const DAY = 24 * 60 * 60 * 1000;

  type Discover = NonNullable<DesktopApi["discoverRecentProjects"]>;

  /**
   * `count` Codex folders, newest first, from the agents part; the first is
   * also a Claude Code project, from the Claude Code history part.
   */
  function discovery(count: number) {
    const now = Date.now();
    return vi.fn<Discover>(async (request) => (request.part === "claude-history"
      ? {
        sources: [{ agent: "claude", label: "Claude Code", status: count > 0 ? "complete" : "skipped" }],
        observations: count > 0 ? [{ path: "/home/sam/code/demo-1/", agent: "claude", lastActiveAt: now - DAY }] : [],
      }
      : {
        sources: [{ agent: "codex", label: "Codex", status: "complete" }],
        observations: Array.from(
          { length: count },
          (_, index) => ({ path: `/home/sam/code/demo-${index + 1}`, agent: "codex", lastActiveAt: now - index * DAY }),
        ),
      }));
  }

  /** The requests made for one part of the search, oldest first. */
  function partRequests(discover: unknown, part: RecentProjectDiscoveryPart): DiscoverRecentProjectsRequest[] {
    return (discover as ReturnType<typeof vi.fn<Discover>>).mock.calls
      .map(([request]) => request)
      .filter((request) => (request.part ?? "agents") === part);
  }

  function projectBoxes(): HTMLInputElement[] {
    const section = screen.getByRole("region", { name: /Projects/ });
    return within(section).queryAllByRole("checkbox") as HTMLInputElement[];
  }

  it("prechecks the 12 most recent projects and keeps the rest behind Review all", async () => {
    const desktopApi = api({ discoverRecentProjects: discovery(15) } as Partial<DesktopApi>);
    renderGetStarted({ desktopApi });
    await waitFor(() => expect(projectBoxes()).toHaveLength(12));
    expect(partRequests(desktopApi.discoverRecentProjects, "agents")).toEqual([{ part: "agents", includeCodex: true }]);
    expect(partRequests(desktopApi.discoverRecentProjects, "claude-history")).toEqual([{ part: "claude-history" }]);
    expect(projectBoxes().every((box) => box.checked)).toBe(true);
    expect(screen.getByRole("heading", { name: "Projects · 12 selected" })).toBeInTheDocument();
    // The same folder from two agents is one row naming both.
    expect(screen.getAllByText("demo-1", { selector: ".get-started__agent-name" })).toHaveLength(1);
    expect(screen.getByText("Codex, Claude Code · Today")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review all (15)" }));
    expect(projectBoxes()).toHaveLength(15);
    expect(projectBoxes().slice(12).some((box) => box.checked)).toBe(false);
    expect(screen.getByText(/Codex threads in these folders appear on their own/)).toBeInTheDocument();
  });

  it("says when a read was partial or an agent could not be read", async () => {
    const desktopApi = api({
      discoverRecentProjects: vi.fn(async (): Promise<DiscoverRecentProjectsResponse> => ({
        sources: [
          { agent: "codex", label: "Codex", status: "partial", detail: "Read the 300 most recent threads. Older projects may be missing." },
          { agent: "claude", label: "Claude Code", status: "failed", detail: "metadata is unreadable" },
        ],
        observations: [],
      })),
    } as Partial<DesktopApi>);
    renderGetStarted({ desktopApi });
    expect(await screen.findByText("Codex: Read the 300 most recent threads. Older projects may be missing."))
      .toBeInTheDocument();
    expect(screen.getByText("Claude Code couldn't be read: metadata is unreadable")).toBeInTheDocument();
    expect(screen.getByText(/No recent projects found/)).toBeInTheDocument();
  });

  it("hands the checked projects to the new profile on Start, and imports no threads", async () => {
    vi.stubEnv("DEV", false);
    const desktopApi = api({
      discoverRecentProjects: discovery(3),
      registerDirectoryFromDisk: vi.fn(),
    } as Partial<DesktopApi>);
    renderGetStarted({ desktopApi });
    await waitFor(() => expect(projectBoxes()).toHaveLength(3));
    fireEvent.click(projectBoxes()[1]!);
    expect(screen.getByRole("heading", { name: "Projects · 2 selected" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(desktopApi.openPwrAgentProfile).toHaveBeenCalledWith({ profile: "default" }));
    expect(desktopApi.createPwrAgentProfile).toHaveBeenCalledWith({
      profile: "default",
      seedOnboardingCompleted: true,
      seedProjectPaths: ["/home/sam/code/demo-1", "/home/sam/code/demo-3"],
    });
    // The bootstrap profile is thrown away, so it registers nothing itself.
    expect(desktopApi.registerDirectoryFromDisk).not.toHaveBeenCalled();
  });

  it("registers the checked projects directly when first run is in a real profile", async () => {
    const registerDirectoryFromDisk = vi.fn(async () => ({ ok: true }));
    const desktopApi = api({
      discoverRecentProjects: discovery(2),
      registerDirectoryFromDisk,
    } as unknown as Partial<DesktopApi>);
    const { onComplete } = renderGetStarted({
      desktopApi,
      bootInfo: { mode: "active-profile", decisionKind: "open", activeProfileName: "work" },
    });
    await waitFor(() => expect(projectBoxes()).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(registerDirectoryFromDisk.mock.calls).toEqual([
      [{ path: "/home/sam/code/demo-1" }],
      [{ path: "/home/sam/code/demo-2" }],
    ]);
    expect(desktopApi.createPwrAgentProfile).not.toHaveBeenCalled();
  });

  it("leaves Codex out for a profile with its own Codex login", async () => {
    const desktopApi = api({ discoverRecentProjects: discovery(0) } as Partial<DesktopApi>);
    renderGetStarted({
      desktopApi,
      bootInfo: { mode: "bootstrap", decisionKind: "missing-named-profile", requestedProfileName: "work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set up work" }));
    await waitFor(() => expect(partRequests(desktopApi.discoverRecentProjects, "agents").at(-1))
      .toEqual({ part: "agents", includeCodex: false }));
    fireEvent.click(screen.getByRole("radio", { name: /This computer's Codex login/ }));
    await waitFor(() => expect(partRequests(desktopApi.discoverRecentProjects, "agents").at(-1))
      .toEqual({ part: "agents", includeCodex: true }));
    // Claude Code's history is the same whichever Codex login is chosen.
    expect(partRequests(desktopApi.discoverRecentProjects, "claude-history")).toHaveLength(1);
  });

  it("looks for projects after the first agent check, and again once a Codex turns up", async () => {
    let finishAcpCheck: (value: { fetchedAt: number; entries: AcpAgentSettingsEntry[] }) => void = () => undefined;
    const settings = settingsState(false);
    const desktopApi = api({
      discoverRecentProjects: discovery(1),
      listAcpAgents: vi.fn(async () => await new Promise((resolve) => { finishAcpCheck = resolve; })),
    } as Partial<DesktopApi>);
    const { setClaudeSignIn } = renderGetStarted({ desktopApi, settings });
    // Codex discovery is still running, so no Codex could be asked yet.
    await waitFor(() => expect(desktopApi.listAcpAgents).toHaveBeenCalled());
    expect(desktopApi.discoverRecentProjects).not.toHaveBeenCalled();
    await act(async () => { finishAcpCheck({ fetchedAt: 1, entries: [] }); });
    await waitFor(() => expect(partRequests(desktopApi.discoverRecentProjects, "agents")).toHaveLength(1));
    // A Codex installed from this page: the next check finds it, and the
    // agents part is read again with it. Claude Code's history is not.
    settings.snapshot = snapshot(true);
    setClaudeSignIn(undefined);
    await waitFor(() => expect(partRequests(desktopApi.discoverRecentProjects, "agents")).toHaveLength(2));
    await settle();
    expect(partRequests(desktopApi.discoverRecentProjects, "claude-history")).toHaveLength(1);
  });

  /** A Claude Code summary as the owner reports it after one check. */
  type ClaudeCheck = "signed-in" | "sign-in-required" | "session-expired" | "unknown" | "not-installed" | "checking";
  const CLAUDE_CHECKS: readonly ClaudeCheck[] = [
    "signed-in", "sign-in-required", "session-expired", "unknown", "not-installed", "checking",
  ];

  function claudeAfter(check: ClaudeCheck): BackendSummary {
    if (check === "not-installed") {
      return { ...claudeSignedIn, available: false, claude: { authStatus: "sign-in-required" } } as BackendSummary;
    }
    if (check === "checking") return { ...claudeSignedIn, discoveryPending: true } as BackendSummary;
    return { ...claudeSignedIn, claude: { ...claudeSignedIn.claude, authStatus: check } } as BackendSummary;
  }

  /** Lets every pending check, discovery and effect finish. */
  async function settle(): Promise<void> {
    await act(async () => {
      for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  /** The agent rows' Check again, as an in-app Claude Code sign-in ending does. */
  function recheck(setClaudeSignIn: (controls?: ClaudeSignInControls) => void): void {
    setClaudeSignIn({ onSignIn: () => undefined, signingIn: true });
    setClaudeSignIn({ onSignIn: () => undefined, signingIn: false });
  }

  function renderWithClaudeChecks(
    checks: readonly ClaudeCheck[],
    discoverRecentProjects: DesktopApi["discoverRecentProjects"] = discovery(1),
  ) {
    let check = 0;
    const desktopApi = api({
      discoverRecentProjects,
      listBackends: vi.fn(async () => ({
        fetchedAt: 1,
        backends: [claudeAfter(checks[Math.min(check++, checks.length - 1)])],
      })),
    } as Partial<DesktopApi>);
    const { setClaudeSignIn } = renderGetStarted({
      desktopApi,
      claudeSignIn: { onSignIn: () => undefined, signingIn: false },
    });
    return { desktopApi, setClaudeSignIn };
  }

  /** A discovery whose answers the test gives, one held answer per request, by part. */
  function heldDiscovery() {
    const held: Record<RecentProjectDiscoveryPart, Array<PromiseWithResolvers<DiscoverRecentProjectsResponse>>> = {
      agents: [],
      "claude-history": [],
    };
    const discover = vi.fn<Discover>(async (request) => {
      const answer = Promise.withResolvers<DiscoverRecentProjectsResponse>();
      held[request.part ?? "agents"].push(answer);
      return await answer.promise;
    });
    return { discover, held };
  }

  async function answer(
    pending: PromiseWithResolvers<DiscoverRecentProjectsResponse> | undefined,
    response: DiscoverRecentProjectsResponse,
  ): Promise<void> {
    expect(pending).toBeDefined();
    await act(async () => { pending!.resolve(response); });
  }

  function projectRow(label: string): HTMLElement {
    return screen.getByText(label, { selector: ".get-started__agent-name" }).closest("li") as HTMLElement;
  }

  it("looks again once Claude Code signs in on this page, and only that once", async () => {
    const { desktopApi, setClaudeSignIn } = renderWithClaudeChecks([
      "sign-in-required", "signed-in", "checking", "signed-in",
    ]);
    const history = () => partRequests(desktopApi.discoverRecentProjects, "claude-history");
    await waitFor(() => expect(history()).toHaveLength(1));
    // Claude Code's history is read only while it is signed in.
    recheck(setClaudeSignIn);
    await waitFor(() => expect(history()).toHaveLength(2));
    // Later checks that find it again keep the list and its checkboxes.
    for (const calls of [3, 4]) {
      recheck(setClaudeSignIn);
      await waitFor(() => expect(desktopApi.listBackends).toHaveBeenCalledTimes(calls));
    }
    await settle();
    expect(history()).toHaveLength(2);
    // Codex and PwrAgent's threads were never asked again.
    expect(partRequests(desktopApi.discoverRecentProjects, "agents")).toHaveLength(1);
  });

  it("keeps the refreshed Claude Code projects when the signed-out look answers last", async () => {
    vi.stubEnv("DEV", false);
    const now = Date.now();
    const codexApp = { path: "/home/sam/code/codex-app", agent: "codex" as const, lastActiveAt: now - DAY };
    const { discover, held } = heldDiscovery();
    const { desktopApi, setClaudeSignIn } = renderWithClaudeChecks(["sign-in-required", "signed-in"], discover);
    // The first look starts while Claude Code is signed out, and its history read is held.
    await waitFor(() => expect(held["claude-history"]).toHaveLength(1));
    await answer(held.agents[0], { sources: [{ agent: "codex", label: "Codex", status: "complete" }], observations: [codexApp] });
    recheck(setClaudeSignIn);
    await waitFor(() => expect(held["claude-history"]).toHaveLength(2));
    await answer(held["claude-history"][1], {
      sources: [{ agent: "claude", label: "Claude Code", status: "complete" }],
      observations: [{ path: "/home/sam/code/claude-app", agent: "claude", lastActiveAt: now }],
    });
    await waitFor(() => expect(projectBoxes()).toHaveLength(2));
    // The signed-out answer arrives last. It read no Claude Code history.
    await answer(held["claude-history"][0], {
      sources: [{ agent: "claude", label: "Claude Code", status: "skipped" }],
      observations: [],
    });
    await settle();
    expect(within(projectRow("claude-app")).getByRole("checkbox")).toBeChecked();
    expect(screen.getByRole("heading", { name: "Projects · 2 selected" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(desktopApi.createPwrAgentProfile).toHaveBeenCalledWith({
      profile: "default",
      seedOnboardingCompleted: true,
      seedProjectPaths: ["/home/sam/code/claude-app", "/home/sam/code/codex-app"],
    }));
  });

  it("reads Claude Code's history one more time exactly when it first turns ready after the first look", async () => {
    // Model: Claude Code's history is read once it is signed in. The first
    // look covers a Claude Code that was ready from the start; one more look
    // covers one that turned ready later; nothing else asks again, and the
    // agents part is never asked again for Claude Code.
    await fc.assert(fc.asyncProperty(
      fc.array(fc.constantFrom(...CLAUDE_CHECKS), { minLength: 1, maxLength: 4 }),
      async (checks) => {
        cleanup();
        const { desktopApi, setClaudeSignIn } = renderWithClaudeChecks(checks);
        await waitFor(() => expect(desktopApi.discoverRecentProjects).toHaveBeenCalled());
        for (let calls = 2; calls <= checks.length; calls += 1) {
          recheck(setClaudeSignIn);
          await waitFor(() => expect(desktopApi.listBackends).toHaveBeenCalledTimes(calls));
        }
        await settle();
        const ready = checks.map((check) => check === "signed-in");
        const expected = !ready[0] && ready.some(Boolean) ? 2 : 1;
        expect(partRequests(desktopApi.discoverRecentProjects, "claude-history")).toHaveLength(expected);
        expect(partRequests(desktopApi.discoverRecentProjects, "agents")).toHaveLength(1);
      },
    ), { numRuns: 20 });
  });

  describe("while Claude Code's history is still being read", () => {
    const now = Date.now();
    /** 13 Codex projects: 12 start checked, demo-13 waits behind Review all. */
    const codexAnswer: DiscoverRecentProjectsResponse = {
      sources: [{ agent: "codex", label: "Codex", status: "complete" }],
      observations: Array.from({ length: 13 }, (_, index) => ({
        path: `/home/sam/code/demo-${index + 1}`,
        agent: "codex" as const,
        lastActiveAt: now - (index + 1) * DAY,
      })),
    };
    const codexPaths = codexAnswer.observations.map(({ path }) => path);

    /** Codex answered, Claude Code's history held; the operator unchecks demo-2 and checks demo-13. */
    async function chooseWhileHistoryIsOut() {
      vi.stubEnv("DEV", false);
      const { discover, held } = heldDiscovery();
      const desktopApi = api({ discoverRecentProjects: discover, backends: [claudeSignedIn] } as Partial<DesktopApi>);
      renderGetStarted({ desktopApi });
      await waitFor(() => expect(held["claude-history"]).toHaveLength(1));
      await answer(held.agents[0], codexAnswer);
      await waitFor(() => expect(projectBoxes()).toHaveLength(12));
      expect(screen.getByText("Looking for more recent projects…")).toBeInTheDocument();
      fireEvent.click(within(projectRow("demo-2")).getByRole("checkbox"));
      fireEvent.click(screen.getByRole("button", { name: "Review all (13)" }));
      fireEvent.click(within(projectRow("demo-13")).getByRole("checkbox"));
      expect(screen.getByRole("heading", { name: "Projects · 12 selected" })).toBeInTheDocument();
      return { desktopApi, history: held["claude-history"][0]! };
    }

    /** The paths Start should seed from the 13 Codex projects after those two toggles. */
    const chosenCodexPaths = codexPaths.filter((path) => !path.endsWith("/demo-2"));

    it("lets the operator choose from the projects found so far and start with them", async () => {
      const { desktopApi } = await chooseWhileHistoryIsOut();
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
      await waitFor(() => expect(desktopApi.createPwrAgentProfile).toHaveBeenCalledWith({
        profile: "default",
        seedOnboardingCompleted: true,
        seedProjectPaths: chosenCodexPaths,
      }));
    });

    it("keeps every choice when the history adds projects, and checks the newest new ones", async () => {
      const { desktopApi, history } = await chooseWhileHistoryIsOut();
      await answer(history, {
        sources: [{ agent: "claude", label: "Claude Code", status: "complete" }],
        observations: [
          // Newer than every Codex project, so it ranks first and starts checked.
          { path: "/home/sam/code/claude-app", agent: "claude", lastActiveAt: now },
          // A folder Codex already listed: one row naming both agents.
          { path: "/home/sam/code/demo-3", agent: "claude", lastActiveAt: now - DAY / 2 },
        ],
      });
      await waitFor(() => expect(screen.queryByText("Looking for more recent projects…")).not.toBeInTheDocument());
      expect(projectBoxes()).toHaveLength(14);
      expect(within(projectRow("demo-2")).getByRole("checkbox")).not.toBeChecked();
      expect(within(projectRow("demo-13")).getByRole("checkbox")).toBeChecked();
      // demo-12 now ranks 13th, past the precheck cut, yet stays as it was shown.
      expect(within(projectRow("demo-12")).getByRole("checkbox")).toBeChecked();
      expect(within(projectRow("claude-app")).getByRole("checkbox")).toBeChecked();
      expect(within(projectRow("demo-3")).getByText(/^Codex, Claude Code/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
      await waitFor(() => expect(desktopApi.createPwrAgentProfile).toHaveBeenCalledWith({
        profile: "default",
        seedOnboardingCompleted: true,
        // Newest first: demo-3's Claude Code activity is newer than demo-1's Codex use.
        seedProjectPaths: [
          "/home/sam/code/claude-app",
          "/home/sam/code/demo-3",
          ...chosenCodexPaths.filter((path) => !path.endsWith("/demo-3")),
        ],
      }));
    });

    it.each([
      {
        outcome: "times out",
        settle: (history: PromiseWithResolvers<DiscoverRecentProjectsResponse>) => answer(history, {
          sources: [{
            agent: "claude",
            label: "Claude Code",
            status: "failed",
            detail: "Claude Code session discovery timed out.",
          }],
          observations: [],
        }),
        notice: "Claude Code couldn't be read: Claude Code session discovery timed out.",
      },
      {
        outcome: "cannot be asked",
        settle: async (history: PromiseWithResolvers<DiscoverRecentProjectsResponse>) => {
          await act(async () => { history.reject(new Error("The window that asked for recent projects closed.")); });
        },
        notice: "Claude Code couldn't be read: The window that asked for recent projects closed.",
      },
    ])("keeps every choice when the history read $outcome", async ({ settle: finish, notice }) => {
      const { desktopApi, history } = await chooseWhileHistoryIsOut();
      await finish(history);
      expect(await screen.findByText(notice)).toBeInTheDocument();
      expect(screen.queryByText("Looking for more recent projects…")).not.toBeInTheDocument();
      expect(projectBoxes()).toHaveLength(13);
      expect(within(projectRow("demo-2")).getByRole("checkbox")).not.toBeChecked();
      expect(within(projectRow("demo-13")).getByRole("checkbox")).toBeChecked();
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
      await waitFor(() => expect(desktopApi.createPwrAgentProfile).toHaveBeenCalledWith({
        profile: "default",
        seedOnboardingCompleted: true,
        seedProjectPaths: chosenCodexPaths,
      }));
    });

    it("lists the history's projects first when it answers before Codex", async () => {
      const { discover, held } = heldDiscovery();
      const desktopApi = api({ discoverRecentProjects: discover } as Partial<DesktopApi>);
      renderGetStarted({ desktopApi });
      await waitFor(() => expect(held.agents).toHaveLength(1));
      await answer(held["claude-history"][0], {
        sources: [{ agent: "claude", label: "Claude Code", status: "complete" }],
        observations: [{ path: "/home/sam/code/claude-app", agent: "claude", lastActiveAt: now }],
      });
      await waitFor(() => expect(projectBoxes()).toHaveLength(1));
      expect(screen.getByText("Looking for more recent projects…")).toBeInTheDocument();
      await answer(held.agents[0], codexAnswer);
      await waitFor(() => expect(projectBoxes()).toHaveLength(12));
      expect(screen.queryByText("Looking for more recent projects…")).not.toBeInTheDocument();
    });
  });

  it("neither looks for nor imports projects in a replay", async () => {
    const desktopApi = api({
      discoverRecentProjects: discovery(3),
      registerDirectoryFromDisk: vi.fn(),
    } as Partial<DesktopApi>);
    const { onComplete } = renderGetStarted({
      desktopApi,
      isReplay: true,
      bootInfo: { mode: "active-profile", decisionKind: "open", activeProfileName: "default" },
    });
    // Done stays disabled until the first agent check finds a ready agent.
    const done = await screen.findByRole("button", { name: "Done" });
    await waitFor(() => expect(done).toBeEnabled());
    fireEvent.click(done);
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(screen.queryByRole("region", { name: /Projects/ })).not.toBeInTheDocument();
    expect(desktopApi.discoverRecentProjects).not.toHaveBeenCalled();
    expect(desktopApi.registerDirectoryFromDisk).not.toHaveBeenCalled();
  });
});
