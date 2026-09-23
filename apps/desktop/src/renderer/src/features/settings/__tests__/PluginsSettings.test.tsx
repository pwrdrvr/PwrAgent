import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AuthorizeMcpConnectionResponse,
  CodexMcpServerSummary,
  DesktopSettingsSnapshot,
  McpConnectionStatus,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { PluginsSettings as PluginsSettingsComponent } from "../PluginsSettings";

afterEach(() => {
  cleanup();
});

const CODEX_HOME = "/Users/operator/.codex/profiles/work";
const DEFAULT_CODEX_HOME = "/Users/operator/.codex";
const onMcpGatewayEnabledChange = vi.fn(async () => undefined);

function PluginsSettings(props: {
  desktopApi?: DesktopApi;
  snapshot: DesktopSettingsSnapshot;
}) {
  return (
    <PluginsSettingsComponent
      {...props}
      onMcpGatewayEnabledChange={onMcpGatewayEnabledChange}
    />
  );
}

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
    general: {
      // The setting's shape, not a bare boolean: the pane reads `.value`, so
      // `true` here ran every test in this file with the gateway off.
      mcpGatewayEnabled: { value: true, source: "default" },
    },
    runtime: {
      messaging: { disabled: false },
      tokenMiser: {
        managedCodex: {
          state: "ready",
          version: options.managedCodexVersion ?? "pwragent-v0.149.0",
        },
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
  it.each([
    ["not_installed", false, "Get PwrGit"],
    ["installed", false, "Open PwrGit"],
    ["running", false, "Connect"],
    ["running", true, "Reauthorize"],
  ] as const)("offers managed PwrGit actions for %s (configured=%s)", async (availability, configured, action) => {
    const api = createDesktopApi([]);
    const status = { connectionId: "pwrgit", displayName: "PwrGit", availability, configured } as const;
    api.readPwrGitConnectionStatus = vi.fn().mockResolvedValue(status);
    api.connectPwrGit = vi.fn().mockResolvedValue({ outcome: "connected", status: { ...status, configured: true } });
    api.openPwrGit = vi.fn().mockResolvedValue({ opened: true });
    api.openPwrGitDownload = vi.fn().mockResolvedValue({ opened: true });
    api.setMcpConnectionEnabled = vi.fn();
    api.listMcpConnections = vi.fn().mockResolvedValue({ connections: [{
      id: "pwrgit", displayName: "PwrGit", serverUrl: "http://127.0.0.1:51731/mcp",
      kind: "pwrgit", authMode: "oauth", enabled: true, configured,
      state: configured ? "ready" : "disconnected", createdAt: 0, updatedAt: 0,
    }] });
    render(<PluginsSettings desktopApi={api} snapshot={createSnapshot()} />);
    const endpoint = await screen.findByText("http://127.0.0.1:51731/mcp");
    const row = within(endpoint.closest("article")!);
    const button = await row.findByRole("button", { name: action });
    expect(row.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    // The availability switch is withheld until PwrAgent actually holds
    // credentials. `enabled` defaults to true, so rendering it unconditionally
    // put an `On` switch beside a `Not connected` state — both true, and
    // together a promise nothing could keep.
    const availabilitySwitch = row.queryByRole("switch", {
      name: "Offer PwrGit to threads",
    });
    if (configured) {
      expect(availabilitySwitch).toBeChecked();
    } else {
      expect(availabilitySwitch).not.toBeInTheDocument();
    }
    fireEvent.click(button);
    const invoked = availability === "not_installed" ? api.openPwrGitDownload
      : availability === "installed" ? api.openPwrGit : api.connectPwrGit;
    await waitFor(() => expect(invoked).toHaveBeenCalled());
  });

  // The credential chip speaks the Codex list's vocabulary; only the setup
  // states that list has no word for -- the app is missing or not running --
  // keep a headline chip of their own. Until the app runs there is nothing to
  // sign in to, so an empty credential says nothing the Get/Open action does
  // not; credentials held from before still do.
  it.each([
    ["not_installed", false, true, ["Not installed"]],
    ["installed", false, true, ["Not running"]],
    ["installed", true, true, ["Not running", "Signed in"]],
    ["running", false, true, ["Sign-in required"]],
    ["running", true, true, ["Signed in"]],
  ] as const)(
    "resolves one state line for %s (configured=%s, gateway=%s)",
    async (availability, configured, gatewayEnabled, chips) => {
      const api = createDesktopApi([]);
      const status = { connectionId: "pwrgit", displayName: "PwrGit", availability, configured } as const;
      api.readPwrGitConnectionStatus = vi.fn().mockResolvedValue(status);
      api.setMcpConnectionEnabled = vi.fn();
      api.listMcpConnections = vi.fn().mockResolvedValue({ connections: [{
        id: "pwrgit", displayName: "PwrGit", serverUrl: "http://127.0.0.1:51731/mcp",
        kind: "pwrgit", authMode: "oauth", enabled: true, configured,
        state: configured ? "ready" : "disconnected", createdAt: 0, updatedAt: 0,
      }] });
      const snapshot = createSnapshot();
      render(
        <PluginsSettings
          desktopApi={api}
          snapshot={{
            ...snapshot,
            general: {
              ...snapshot.general,
              mcpGatewayEnabled: { value: gatewayEnabled, source: "default" },
            },
          }}
        />,
      );
      const endpoint = await screen.findByText("http://127.0.0.1:51731/mcp");
      const article = endpoint.closest("article")!;
      const row = within(article);
      expect(await row.findByText(chips[0])).toBeInTheDocument();
      expect(
        Array.from(
          article.querySelectorAll(".settings-mcp-row__chips > .settings-pathrow__chip"),
        ).map((chip) => chip.textContent),
      ).toEqual(chips);
      // Exactly one claim: the chip pair that used to contradict itself is
      // gone.
      expect(row.queryByText("Not connected")).not.toBeInTheDocument();
    },
  );

  it("says the gateway is the reason, in the row that is affected by it", async () => {
    const api = createDesktopApi([]);
    api.readPwrGitConnectionStatus = vi.fn().mockResolvedValue({
      connectionId: "pwrgit", displayName: "PwrGit", availability: "running", configured: true,
    });
    api.setMcpConnectionEnabled = vi.fn();
    api.listMcpConnections = vi.fn().mockResolvedValue({ connections: [{
      id: "pwrgit", displayName: "PwrGit", serverUrl: "http://127.0.0.1:51731/mcp",
      kind: "pwrgit", authMode: "oauth", enabled: true, configured: true,
      state: "ready", createdAt: 0, updatedAt: 0,
    }] });
    const snapshot = createSnapshot();
    render(
      <PluginsSettings
        desktopApi={api}
        snapshot={{
          ...snapshot,
          general: {
            ...snapshot.general,
            mcpGatewayEnabled: { value: false, source: "default" },
          },
        }}
      />,
    );
    const endpoint = await screen.findByText("http://127.0.0.1:51731/mcp");
    const row = within(endpoint.closest("article")!);
    // The switch went dim with the reason stated 400px away, at the section
    // top. A row-level consequence needs a row-level reason.
    expect(await row.findByText("Gateway off")).toBeInTheDocument();
    expect(row.queryByText("Ready")).not.toBeInTheDocument();
  });

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
  /**
   * An OAuth round trip leaves for the browser, and the pane cannot see what
   * happens there. The wait used to hold the card's one latch: every button on
   * every row went dim, the add form with them, and the only way out was a
   * Stop waiting at the top of the card -- a screen away from the row it
   * stopped on a long list. The wait now belongs to its row.
   */
  it("waits on the row that is signing in, with its way out beside it", async () => {
    const api = createDesktopApi([]);
    const cancel = vi.fn().mockResolvedValue({ connectionId: "rovo" });
    const rovo: McpConnectionStatus = {
      id: "rovo", displayName: "Atlassian Rovo",
      serverUrl: "https://mcp.atlassian.com/v2/mcp",
      kind: "remote", authMode: "oauth", enabled: true, configured: false,
      state: "disconnected", createdAt: 0, updatedAt: 0,
    };
    const datadog: McpConnectionStatus = {
      id: "datadog", displayName: "Datadog",
      serverUrl: "https://mcp.datadoghq.com/v1/mcp",
      kind: "remote", authMode: "oauth", enabled: true, configured: true,
      state: "ready", createdAt: 0, updatedAt: 0,
    };
    // Each attempt is held open so the test can settle it *after* its row
    // has moved on, which is what an abandoned browser round trip does.
    const attempts: Array<{
      connectionId: string;
      reject: (cause: Error) => void;
    }> = [];
    const authorize = vi.fn(
      (request: { connectionId: string }) =>
        new Promise<AuthorizeMcpConnectionResponse>((_resolve, reject) => {
          attempts.push({ connectionId: request.connectionId, reject });
        }),
    );
    api.authorizeMcpConnection = authorize;
    api.cancelMcpConnectionAuthorization = cancel;
    api.listMcpConnections = vi.fn().mockResolvedValue({
      connections: [rovo, datadog],
    });
    render(<PluginsSettings desktopApi={api} snapshot={createSnapshot()} />);

    const rovoRow = within(
      (await screen.findByText(rovo.serverUrl)).closest("article")!,
    );
    const datadogRow = within(
      screen.getByText(datadog.serverUrl).closest("article")!,
    );
    fireEvent.click(rovoRow.getByRole("button", { name: "Authorize" }));

    // The wait and its Cancel stand where Authorize was.
    expect(await rovoRow.findByRole("status")).toHaveTextContent(
      "Waiting for sign-in…",
    );
    expect(
      rovoRow.getByRole("button", { name: "Cancel sign-in to Atlassian Rovo" }),
    ).toBeEnabled();
    expect(
      rovoRow.getByText("Finish signing in to Atlassian Rovo in your browser."),
    ).toBeInTheDocument();
    expect(rovoRow.queryByRole("button", { name: "Authorize" }))
      .not.toBeInTheDocument();
    expect(rovoRow.queryByRole("button", { name: "Edit" }))
      .not.toBeInTheDocument();
    expect(rovoRow.queryByRole("button", { name: "Remove" }))
      .not.toBeInTheDocument();
    // Nothing is said about it anywhere but its row.
    expect(screen.queryByText(/authorization to complete/))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop waiting" }))
      .not.toBeInTheDocument();

    // Every other row, and the add form, stay usable.
    for (const name of ["Reauthorize", "Disconnect", "Edit", "Remove"]) {
      expect(datadogRow.getByRole("button", { name })).toBeEnabled();
    }
    expect(screen.getByLabelText("Remote MCP URL")).toBeEnabled();

    // So a second sign-in can run beside the first.
    fireEvent.click(datadogRow.getByRole("button", { name: "Reauthorize" }));
    expect(
      await datadogRow.findByRole("button", { name: "Cancel sign-in to Datadog" }),
    ).toBeEnabled();
    expect(authorize).toHaveBeenCalledTimes(2);

    fireEvent.click(
      rovoRow.getByRole("button", { name: "Cancel sign-in to Atlassian Rovo" }),
    );
    await waitFor(() => {
      expect(rovoRow.getByRole("button", { name: "Authorize" })).toBeEnabled();
    });
    expect(cancel).toHaveBeenCalledWith({ connectionId: "rovo" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(rovoRow.getByRole("button", { name: "Edit" })).toBeEnabled();
    expect(rovoRow.queryByRole("status")).not.toBeInTheDocument();
    // Cancelling one sign-in is not cancelling the other.
    expect(
      datadogRow.getByRole("button", { name: "Cancel sign-in to Datadog" }),
    ).toBeInTheDocument();

    // A fresh attempt, then the main process ends the abandoned one the way
    // it does: by rejecting it. Landing on a stale attempt, that is neither a
    // failure to report nor the end of the wait that replaced it.
    fireEvent.click(rovoRow.getByRole("button", { name: "Authorize" }));
    expect(
      await rovoRow.findByRole("button", { name: "Cancel sign-in to Atlassian Rovo" }),
    ).toBeInTheDocument();
    const abandoned = attempts.find((entry) => entry.connectionId === "rovo")!;
    await act(async () => {
      abandoned.reject(new Error("Atlassian Rovo authorization was cancelled."));
    });
    expect(rovoRow.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      rovoRow.getByRole("button", { name: "Cancel sign-in to Atlassian Rovo" }),
    ).toBeInTheDocument();
    expect(authorize).toHaveBeenCalledTimes(3);
  });

  /**
   * A failure used to land in the card's notice, a screen away from the row
   * on a long list -- and it pushed every row down as it appeared.
   */
  it("writes a failed sign-in under the row that tried it", async () => {
    const api = createDesktopApi([]);
    const rovo: McpConnectionStatus = {
      id: "rovo", displayName: "Atlassian Rovo",
      serverUrl: "https://mcp.atlassian.com/v2/mcp",
      kind: "remote", authMode: "oauth", enabled: true, configured: false,
      state: "disconnected", createdAt: 0, updatedAt: 0,
    };
    api.authorizeMcpConnection = vi.fn()
      .mockRejectedValueOnce(new Error("The server refused the redirect URL."))
      .mockReturnValueOnce(new Promise(() => {}));
    api.listMcpConnections = vi.fn().mockResolvedValue({ connections: [rovo] });
    render(<PluginsSettings desktopApi={api} snapshot={createSnapshot()} />);

    const article = (await screen.findByText(rovo.serverUrl)).closest("article")!;
    const row = within(article);
    fireEvent.click(row.getByRole("button", { name: "Authorize" }));

    expect(await row.findByRole("alert")).toHaveTextContent(
      "Sign-in failed: The server refused the redirect URL.",
    );
    // The row's alert is the only one.
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(row.getByRole("button", { name: "Authorize" })).toBeEnabled();

    // Trying again retires the old failure rather than stacking under it.
    fireEvent.click(row.getByRole("button", { name: "Authorize" }));
    expect(
      await row.findByRole("button", { name: "Cancel sign-in to Atlassian Rovo" }),
    ).toBeInTheDocument();
    expect(row.queryByRole("alert")).not.toBeInTheDocument();
  });

  /**
   * Connect on a local app ends in the same browser sign-in as Reauthorize,
   * but it ran on a latch of its own: a disabled "Connecting..." that nothing
   * could call off.
   */
  it("lets a local app's Connect be called off like any other sign-in", async () => {
    const api = createDesktopApi([]);
    const cancel = vi.fn().mockResolvedValue({ connectionId: "pwrgit" });
    api.readPwrGitConnectionStatus = vi.fn().mockResolvedValue({
      connectionId: "pwrgit", displayName: "PwrGit",
      availability: "running", configured: false,
    });
    api.connectPwrGit = vi.fn(() => new Promise<never>(() => {}));
    api.cancelMcpConnectionAuthorization = cancel;
    api.listMcpConnections = vi.fn().mockResolvedValue({ connections: [{
      id: "pwrgit", displayName: "PwrGit", serverUrl: "http://127.0.0.1:51731/mcp",
      kind: "pwrgit", authMode: "oauth", enabled: true, configured: false,
      state: "disconnected", createdAt: 0, updatedAt: 0,
    }] });
    render(<PluginsSettings desktopApi={api} snapshot={createSnapshot()} />);

    const row = within(
      (await screen.findByText("http://127.0.0.1:51731/mcp")).closest("article")!,
    );
    fireEvent.click(await row.findByRole("button", { name: "Connect" }));
    fireEvent.click(
      await row.findByRole("button", { name: "Cancel sign-in to PwrGit" }),
    );

    expect(await row.findByRole("button", { name: "Connect" })).toBeEnabled();
    expect(cancel).toHaveBeenCalledWith({ connectionId: "pwrgit" });
  });
  /**
   * The endpoint is the one thing in the row an operator hands to something
   * else verbatim — a `curl`, a bug report, the agent's own config when a
   * server turns out to belong there instead. It was selectable text in a row
   * full of buttons, which in practice means a drag that catches the row.
   */
  it("copies each connection's endpoint through the shared affordance", async () => {
    const api = createDesktopApi([]);
    const copyText = vi.fn().mockResolvedValue(undefined);
    api.copyText = copyText;
    api.listMcpConnections = vi.fn().mockResolvedValue({ connections: [
      {
        id: "rovo", displayName: "Atlassian Rovo",
        serverUrl: "https://mcp.atlassian.com/v2/mcp",
        kind: "remote", authMode: "oauth", enabled: true, configured: false,
        state: "disconnected", createdAt: 0, updatedAt: 0,
      },
      {
        id: "datadog", displayName: "Datadog",
        serverUrl: "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp",
        kind: "remote", authMode: "oauth", enabled: true, configured: true,
        state: "ready", createdAt: 0, updatedAt: 0,
      },
    ] });
    render(<PluginsSettings desktopApi={api} snapshot={createSnapshot()} />);

    // Named per connection: a row full of identical "Copy" buttons is
    // unusable by anything that reads names rather than sees positions.
    const copy = await screen.findByRole("button", {
      name: "Copy Atlassian Rovo MCP URL",
    });
    fireEvent.click(copy);
    await waitFor(() => {
      expect(copyText).toHaveBeenCalledWith("https://mcp.atlassian.com/v2/mcp");
    });
    // The acknowledgement is what tells the operator it landed; the endpoint
    // is invisible in the clipboard, so a silent button reads as a dead one.
    expect(await screen.findByRole("button", {
      name: "Copy Atlassian Rovo MCP URL",
    })).toHaveTextContent("Copied");

    fireEvent.click(
      screen.getByRole("button", { name: "Copy Datadog MCP URL" }),
    );
    await waitFor(() => {
      expect(copyText).toHaveBeenLastCalledWith(
        "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp",
      );
    });
  });
  /**
   * Disconnect and Remove differ only in whether the row survives, and the
   * row said nothing about which was which — two destructive-looking buttons
   * side by side, one of which is recoverable and one of which is not.
   */
  it("says what Disconnect keeps and Remove does not", async () => {
    const api = createDesktopApi([]);
    api.listMcpConnections = vi.fn().mockResolvedValue({ connections: [{
      id: "rovo", displayName: "Atlassian Rovo",
      serverUrl: "https://mcp.atlassian.com/v2/mcp",
      kind: "remote", authMode: "oauth", enabled: true, configured: true,
      state: "ready", createdAt: 0, updatedAt: 0,
    }] });
    render(<PluginsSettings desktopApi={api} snapshot={createSnapshot()} />);

    const disconnect = await screen.findByRole("button", { name: "Disconnect" });
    // The recoverable one has to say it is recoverable; that is the whole
    // distinction an operator is choosing between.
    expect(disconnect).toHaveAttribute(
      "title",
      expect.stringContaining("stays in this list"),
    );
    expect(screen.getByRole("button", { name: "Remove" })).toHaveAttribute(
      "title",
      expect.stringContaining("entirely"),
    );
  });

  describe("PwrAgent-managed rows", () => {
    function managed(
      overrides: Partial<McpConnectionStatus> = {},
    ): McpConnectionStatus {
      return {
        id: "datadog",
        displayName: "Datadog",
        serverUrl: "https://mcp.example.com/mcp",
        kind: "remote",
        authMode: "oauth",
        enabled: true,
        configured: true,
        state: "ready",
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
      };
    }

    function managedApi(
      connections: McpConnectionStatus[],
      tools: string[] = [],
    ): DesktopApi {
      const api = createDesktopApi([]);
      api.listMcpConnections = vi.fn().mockResolvedValue({ connections });
      api.listMcpConnectionTools = vi.fn(async (request) => ({
        connectionId: request.connectionId,
        tools,
        fetchedAt: 1,
      }));
      api.setMcpConnectionEnabled = vi.fn();
      api.setMcpConnectionSelectForNewThreads = vi.fn();
      return api;
    }

    async function findRow(name: string) {
      const endpoint = await screen.findByText("https://mcp.example.com/mcp");
      const article = endpoint.closest("article")!;
      expect(within(article).getByText(name)).toBeInTheDocument();
      return article;
    }

    /**
     * The Codex list below has always shown every tool of every server; a
     * managed connection showed a name and a URL. The gateway can read the
     * list itself, so the row now says what the Codex row says.
     */
    it("shows a managed connection's tools the way the Codex list does", async () => {
      const tools = Array.from({ length: 15 }, (_, index) => `tool_${index + 1}`);
      const api = managedApi([managed()], tools);
      render(<PluginsSettings desktopApi={api} snapshot={createSnapshot()} />);

      const article = await findRow("Datadog");
      const row = within(article);
      expect(await row.findByText("15 tools")).toBeInTheDocument();
      const toggle = row.getByRole("button", { name: /^Datadog/ });
      expect(article).toHaveAttribute("data-health", "ready");
      expect(api.listMcpConnectionTools).toHaveBeenCalledWith({
        connectionId: "datadog",
      });

      fireEvent.click(toggle);
      expect(row.getByText(/tool_1, tool_2/)).toBeInTheDocument();
      expect(
        row.getByRole("button", { name: "Show 3 more Tools" }),
      ).toBeInTheDocument();

      // A managed list is read once and kept, so a server that gained a tool
      // needs a way to be asked again.
      fireEvent.click(row.getByRole("button", { name: "Refresh tools" }));
      await waitFor(() => {
        expect(api.listMcpConnectionTools).toHaveBeenLastCalledWith({
          connectionId: "datadog",
          refresh: true,
        });
      });
    });

    it("does not ask a connection that cannot answer", async () => {
      const api = managedApi([
        managed({ configured: false, state: "disconnected" }),
      ]);
      render(<PluginsSettings desktopApi={api} snapshot={createSnapshot()} />);

      const row = within(await findRow("Datadog"));
      // The same words the Codex list uses for a server in this state.
      expect(row.getByText("no tools — sign-in required")).toBeInTheDocument();
      expect(row.getByText("Sign-in required")).toBeInTheDocument();
      expect(api.listMcpConnectionTools).not.toHaveBeenCalled();
    });

    it("says when a listing failed, instead of claiming an empty server", async () => {
      const api = managedApi([managed()]);
      api.listMcpConnectionTools = vi.fn(async () => {
        throw new Error("upstream answered 502");
      });
      render(<PluginsSettings desktopApi={api} snapshot={createSnapshot()} />);

      const article = await findRow("Datadog");
      const row = within(article);
      expect(
        await row.findByText("no tools — could not list them"),
      ).toBeInTheDocument();
      expect(row.getByText("upstream answered 502")).toBeInTheDocument();
      expect(article).toHaveAttribute("data-health", "failed");
    });

    /**
     * Two switches on one row, one per question. Offer decides whether a
     * thread may use the connection at all; the other decides whether a new
     * thread starts with it already chosen.
     */
    it("keeps selecting for new threads apart from offering to threads", async () => {
      const api = managedApi([managed()]);
      render(<PluginsSettings desktopApi={api} snapshot={createSnapshot()} />);

      const row = within(await findRow("Datadog"));
      const offer = row.getByRole("switch", { name: "Offer Datadog to threads" });
      const newThreads = row.getByRole("switch", {
        name: "Select Datadog for new threads",
      });
      expect(offer).toBeChecked();
      expect(newThreads).not.toBeChecked();
      expect(row.getByText("Offer to threads")).toBeInTheDocument();
      expect(row.getByText("Select for new threads")).toBeInTheDocument();

      fireEvent.click(newThreads);
      await waitFor(() => {
        expect(api.setMcpConnectionSelectForNewThreads).toHaveBeenCalledWith({
          connectionId: "datadog",
          selectForNewThreads: true,
        });
      });
      // New threads only: the notice says so, because the obvious fear is a
      // running thread quietly gaining a server.
      expect(
        await screen.findByText(
          "New threads start with Datadog selected. Existing threads are unchanged.",
        ),
      ).toBeInTheDocument();
      expect(api.setMcpConnectionEnabled).not.toHaveBeenCalled();
    });

    /**
     * Reauthorizing a working connection can switch accounts while its URL and
     * its `configured` flag stay the same, which is all the row watched. The
     * read after a sign-in skips the main-process cache, because PwrSnap and
     * PwrGit sign in outside the path that invalidates it.
     */
    it("re-reads the tools after a sign-in, past any cached list", async () => {
      const api = managedApi([managed()], ["from_the_old_account"]);
      api.authorizeMcpConnection = vi.fn(async () => ({
        connectionId: "datadog",
        connection: managed(),
      }));
      render(<PluginsSettings desktopApi={api} snapshot={createSnapshot()} />);

      const row = within(await findRow("Datadog"));
      expect(await row.findByText("1 tool")).toBeInTheDocument();
      expect(api.listMcpConnectionTools).toHaveBeenLastCalledWith({
        connectionId: "datadog",
      });

      fireEvent.click(row.getByRole("button", { name: "Reauthorize" }));

      await waitFor(() => {
        expect(api.listMcpConnectionTools).toHaveBeenLastCalledWith({
          connectionId: "datadog",
          refresh: true,
        });
      });
    });

    it("says a connection waiting on a sign-in is skipped for now", async () => {
      const api = managedApi([
        managed({
          selectForNewThreads: true,
          state: "reauthorization_required",
        }),
      ]);
      render(<PluginsSettings desktopApi={api} snapshot={createSnapshot()} />);

      const row = within(await findRow("Datadog"));
      // The preference stands, but seeding skips a connection whose sign-in
      // stopped working, so the hint must not promise the next thread it.
      expect(
        row.getByRole("switch", { name: "Select Datadog for new threads" }),
      ).toBeChecked();
      expect(
        row.getByText("New threads skip it until it is signed in again."),
      ).toBeInTheDocument();
      expect(
        row.queryByText(/New threads start with it selected/),
      ).not.toBeInTheDocument();
    });

    it("never shows a parked connection as selected for new threads", async () => {
      const api = managedApi([
        managed({ enabled: false, selectForNewThreads: true }),
      ]);
      render(<PluginsSettings desktopApi={api} snapshot={createSnapshot()} />);

      const row = within(await findRow("Datadog"));
      const newThreads = row.getByRole("switch", {
        name: "Select Datadog for new threads",
      });
      // The preference is kept for when the connection is offered again, but
      // a parked connection is not seeded -- `On` here would be a promise the
      // next thread breaks.
      expect(newThreads).not.toBeChecked();
      expect(newThreads).toBeDisabled();
      expect(row.getByText("Offer it to threads first.")).toBeInTheDocument();
      expect(row.getByText("Parked")).toBeInTheDocument();
    });
  });
});
