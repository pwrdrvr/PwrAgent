import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CodexMcpServerSummary,
  DesktopSettingsSnapshot,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { PluginsSettings } from "../PluginsSettings";

afterEach(() => {
  cleanup();
});

const CODEX_HOME = "/Users/operator/.codex/profiles/work";
const DEFAULT_CODEX_HOME = "/Users/operator/.codex";

/**
 * The pane reads three things off the snapshot. Building the whole
 * `DesktopSettingsSnapshot` here would be ~200 lines of unrelated defaults, so
 * this narrows to what it actually consumes; the cast is what keeps that
 * honest rather than a partial type that would hide a new read.
 */
function createSnapshot(options: {
  codexHome?: string;
  managedCodexVersion?: string;
  profileName?: string;
} = {}): DesktopSettingsSnapshot {
  const profileName = options.profileName ?? "work";
  const codexHome = options.codexHome ?? CODEX_HOME;
  return {
    runtime: {
      messaging: { disabled: false },
      tokenMiser: {
        managedCodex: {
          state: "ready",
          version: options.managedCodexVersion ?? "pwragent-v0.149.0",
        },
        interceptionCount: 0,
        originalCharacters: 0,
        baselineParentTokens: 0,
        replacementTokens: 0,
        retrievedTokens: 0,
        estimatedParentTokensSaved: 0,
      },
    },
    models: {
      codex: {
        profiles: {
          profileRoot: `${DEFAULT_CODEX_HOME}/profiles`,
          effectiveCodexHome: codexHome,
          profiles: [
            {
              name: "",
              displayName: "System default",
              codexHome: DEFAULT_CODEX_HOME,
              source: "default",
              exists: true,
              selected: profileName === "",
              hasAuthFile: true,
              hasConfigFile: true,
            },
            {
              name: "work",
              displayName: "work",
              codexHome: CODEX_HOME,
              source: "directory",
              exists: true,
              selected: profileName === "work",
              hasAuthFile: true,
              hasConfigFile: true,
            },
          ],
        },
      },
    },
  } as unknown as DesktopSettingsSnapshot;
}

function server(
  overrides: Partial<CodexMcpServerSummary> & { name: string },
): CodexMcpServerSummary {
  return {
    authStatus: "unsupported",
    tools: [],
    ...overrides,
  };
}

function createDesktopApi(
  servers: CodexMcpServerSummary[],
  codexHome = CODEX_HOME,
): DesktopApi {
  return {
    listCodexMcpServers: vi.fn().mockResolvedValue({
      codexHome,
      detail: "toolsAndAuthOnly",
      servers,
    }),
    reloadCodexMcpServers: vi.fn().mockResolvedValue({ codexHome, queued: true }),
    removeCodexMcpServer: vi.fn(),
    startCodexMcpServerLogin: vi.fn(),
    onAgentEvent: vi.fn().mockReturnValue(() => {}),
  } as unknown as DesktopApi;
}

describe("PluginsSettings", () => {
  it("shows each server's tools instead of only counting them", async () => {
    const tools = Array.from({ length: 28 }, (_, index) => `tool_${index + 1}`);
    render(
      <PluginsSettings
        desktopApi={createDesktopApi([
          server({ name: "datadog", authStatus: "oAuth", tools }),
        ])}
        snapshot={createSnapshot()}
      />,
    );

    const toggle = await screen.findByRole("button", { name: /^datadog/ });
    // Collapsed, the row still only claims a count — the defect was that this
    // was the *only* thing the pane ever said about 206 tools.
    expect(screen.queryByText(/tool_1,/)).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(screen.getByText(/tool_1, tool_2/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show 16 more Tools" }),
    ).toBeInTheDocument();
  });

  it("tells a server that publishes nothing apart from one that never started", async () => {
    render(
      <PluginsSettings
        desktopApi={createDesktopApi([
          server({ name: "awsdocs", startupStatus: "ready" }),
          server({ name: "atlassian", authStatus: "notLoggedIn" }),
          server({
            name: "broken",
            startupStatus: "failed",
            startupError: "spawn ENOENT",
          }),
        ])}
        snapshot={createSnapshot()}
      />,
    );

    expect(
      await screen.findByText("ready — no tools published"),
    ).toBeInTheDocument();
    expect(screen.getByText("no tools — sign-in required")).toBeInTheDocument();
    expect(screen.getByText("no tools — failed to start")).toBeInTheDocument();
    expect(screen.getByText("spawn ENOENT")).toBeInTheDocument();
  });

  it("names the sign-in state rather than the mechanism", async () => {
    render(
      <PluginsSettings
        desktopApi={createDesktopApi([
          server({ name: "datadog", authStatus: "oAuth", tools: ["a"] }),
          server({ name: "codex_apps", authStatus: "bearerToken", tools: ["b"] }),
          server({ name: "awsdocs", startupStatus: "ready" }),
        ])}
        snapshot={createSnapshot()}
      />,
    );

    expect(await screen.findByText("Signed in")).toBeInTheDocument();
    expect(screen.getByText("Signed in · token")).toBeInTheDocument();
    expect(screen.getByText("No sign-in needed")).toBeInTheDocument();
    expect(screen.queryByText("OAuth")).not.toBeInTheDocument();
    expect(screen.queryByText("No login")).not.toBeInTheDocument();
  });

  it("counts health, not configuration", async () => {
    render(
      <PluginsSettings
        desktopApi={createDesktopApi([
          server({ name: "a", authStatus: "oAuth", tools: ["t1", "t2"] }),
          server({ name: "b", authStatus: "notLoggedIn" }),
          server({
            name: "c",
            startupStatus: "failed",
            startupError: "boom",
          }),
        ])}
        snapshot={createSnapshot()}
      />,
    );

    expect(await screen.findByText("3 servers · 2 tools")).toBeInTheDocument();
    expect(screen.getByText("1 ready")).toBeInTheDocument();
    expect(screen.getByText("1 need sign-in")).toBeInTheDocument();
    expect(screen.getByText("1 failed")).toBeInTheDocument();
    expect(screen.queryByText("3 configured")).not.toBeInTheDocument();
  });

  it("offers Sign in only where the operator has something to do", async () => {
    render(
      <PluginsSettings
        desktopApi={createDesktopApi([
          server({ name: "signed-in", authStatus: "oAuth", tools: ["t"] }),
          server({ name: "needs-login", authStatus: "notLoggedIn" }),
        ])}
        snapshot={createSnapshot()}
      />,
    );

    await screen.findByRole("button", { name: /^needs-login/ });
    expect(screen.getAllByRole("button", { name: "Sign in" })).toHaveLength(1);
  });

  it("keeps Remove out of the collapsed row", async () => {
    render(
      <PluginsSettings
        desktopApi={createDesktopApi([
          server({ name: "datadog", authStatus: "oAuth", tools: ["t"] }),
        ])}
        snapshot={createSnapshot()}
      />,
    );

    await screen.findByRole("button", { name: /^datadog/ });
    // It used to render on all twelve rows at full prominence — the most
    // destructive verb on the pane was also its most available one.
    expect(screen.queryByRole("button", { name: /^Remove/ })).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "More actions for datadog" }),
    ).toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "More actions for datadog" });
    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toHaveClass("settings-mcp-context-menu");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitem", { name: "Remove datadog" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    fireEvent.click(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("does not dismiss an open menu for clicks on its invoker", async () => {
    render(
      <PluginsSettings
        desktopApi={createDesktopApi([
          server({ name: "pwrsnap" }),
          server({ name: "context7" }),
        ])}
        snapshot={createSnapshot()}
      />,
    );

    const trigger = await screen.findByRole("button", { name: "More actions for pwrsnap" });
    fireEvent.click(trigger);
    // Exercise an invoker click with the window dismiss listener installed.
    // Browsers can install it during the opening click, before it reaches
    // window; fireEvent's act batching postpones that until after dispatch.
    fireEvent.click(within(trigger).getByText("···"));
    expect(screen.getByRole("menuitem", { name: "Remove pwrsnap" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "More actions for context7" }));
    expect(screen.queryByRole("menuitem", { name: "Remove pwrsnap" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Remove context7" })).toBeInTheDocument();
  });

  it("filters by server name and by tool name", async () => {
    render(
      <PluginsSettings
        desktopApi={createDesktopApi([
          server({ name: "datadog", authStatus: "oAuth", tools: ["aggregate_spans"] }),
          server({ name: "context7", tools: ["resolve-library-id"] }),
        ])}
        snapshot={createSnapshot()}
      />,
    );

    const filter = await screen.findByLabelText("Filter MCP servers and tools");

    fireEvent.change(filter, { target: { value: "context" } });
    expect(screen.queryByRole("button", { name: /^datadog/ })).not.toBeInTheDocument();

    fireEvent.change(filter, { target: { value: "aggregate_spans" } });
    expect(screen.getByRole("button", { name: /^datadog/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^context7/ })).not.toBeInTheDocument();
  });

  it("names the Codex profile and build the list came from", async () => {
    render(
      <PluginsSettings
        desktopApi={createDesktopApi([server({ name: "a", tools: ["t"] })])}
        snapshot={createSnapshot()}
      />,
    );

    expect(await screen.findByText("~/.codex/profiles/work")).toBeInTheDocument();
    expect(screen.getByText("PwrAgent managed")).toBeInTheDocument();
    expect(screen.getByText("pwragent-v0.149.0")).toBeInTheDocument();
    expect(
      screen.getByText(/have its own separate sign-ins|separate\s+sign-ins/),
    ).toBeInTheDocument();
  });

  it("does not warn about a split that does not exist on System default", async () => {
    render(
      <PluginsSettings
        desktopApi={createDesktopApi(
          [server({ name: "a", tools: ["t"] })],
          DEFAULT_CODEX_HOME,
        )}
        snapshot={createSnapshot({
          codexHome: DEFAULT_CODEX_HOME,
          profileName: "",
        })}
      />,
    );

    // System default *is* `~/.codex`, so PwrAgent and a bare `codex` share one
    // store. Warning about separate sign-ins there would be false.
    expect(await screen.findByText("System default")).toBeInTheDocument();
    expect(screen.queryByText(/separate\s+sign-ins/)).not.toBeInTheDocument();
  });

  it("keeps row health current from startup notifications after mount", async () => {
    let emit: ((event: { notification: { method: string; params: Record<string, unknown> } }) => void) | undefined;
    const desktopApi = {
      ...createDesktopApi([server({ name: "flaky" })]),
      onAgentEvent: vi.fn((listener: typeof emit) => {
        emit = listener;
        return () => {};
      }),
    } as unknown as DesktopApi;

    render(<PluginsSettings desktopApi={desktopApi} snapshot={createSnapshot()} />);

    expect(
      await screen.findByText("no tools reported — not started yet"),
    ).toBeInTheDocument();

    // The pane used to consume these only while a sign-in was in flight, so a
    // server that died on launch stayed indistinguishable from a quiet one.
    emit?.({
      notification: {
        method: "mcpServer/startupStatus/updated",
        params: { name: "flaky", status: "failed", error: "connect ECONNREFUSED" },
      },
    });

    await waitFor(() => {
      expect(screen.getByText("no tools — failed to start")).toBeInTheDocument();
    });
    expect(screen.getByText("connect ECONNREFUSED")).toBeInTheDocument();
    const counts = screen.getByText("1 failed");
    expect(within(counts).queryByText("0")).not.toBeInTheDocument();
  });

  it("finishes a sign-in whose server reports starting before it reports ready", async () => {
    let emit: ((event: { notification: { method: string; params: Record<string, unknown> } }) => void) | undefined;
    const desktopApi = {
      ...createDesktopApi([
        server({ name: "datadog", authStatus: "notLoggedIn" }),
      ]),
      startCodexMcpServerLogin: vi.fn().mockResolvedValue({ ok: true }),
      onAgentEvent: vi.fn((listener: typeof emit) => {
        emit = listener;
        return () => {};
      }),
    } as unknown as DesktopApi;

    render(<PluginsSettings desktopApi={desktopApi} snapshot={createSnapshot()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(desktopApi.startCodexMcpServerLogin).toHaveBeenCalled();
    });

    emit?.({
      notification: {
        method: "mcpServer/oauthLogin/completed",
        params: { serverName: "datadog", success: true },
      },
    });

    // A reload reports `starting` before it reports `ready`. Treating that as
    // a terminal answer disarmed the waiter without resolving it, so the
    // promise the pane awaits never settled and every control on the row
    // stayed disabled for the life of the window.
    emit?.({
      notification: {
        method: "mcpServer/startupStatus/updated",
        params: { name: "datadog", status: "starting" },
      },
    });
    emit?.({
      notification: {
        method: "mcpServer/startupStatus/updated",
        params: { name: "datadog", status: "ready" },
      },
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "More actions for datadog" }),
      ).toBeEnabled();
    });
  });
});
