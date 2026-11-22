import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpAgentSettingsEntry, BackendSummary } from "@pwragent/shared/contracts/backend";
import type { DesktopBootInfo, DesktopSettingsSnapshot } from "@pwragent/shared/contracts/settings";
import type { DesktopApi } from "../../../lib/desktop-api";
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
}) {
  const settings = params.settings ?? settingsState(true);
  const onComplete = vi.fn(async () => undefined);
  const onDismiss = vi.fn();
  render(
    <GetStarted
      isReplay={params.isReplay ?? false}
      bootInfo={params.bootInfo === undefined ? firstRun : params.bootInfo}
      settings={settings}
      desktopApi={params.desktopApi}
      onComplete={onComplete}
      onDismiss={onDismiss}
    />,
  );
  return { settings, onComplete, onDismiss };
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
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
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
