import "@testing-library/jest-dom/vitest";
import { StrictMode, useState } from "react";
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
  AcpAgentSettingsEntry,
  DesktopSettingsSnapshot,
} from "@pwragent/shared";
import { AcpAgentsSettings } from "../AcpAgentsSettings";
import type { DesktopApi } from "../../../lib/desktop-api";
import { BACKEND_SUMMARIES_REFRESH_EVENT } from "../../../lib/useBackendSummaries";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function geminiEntry(): AcpAgentSettingsEntry {
  return {
    backendId: "acp:gemini",
    registryId: "gemini",
    name: "Gemini CLI",
    version: "0.42.0",
    authors: [],
    distributionKind: "local",
    distributionSource: "gemini --acp --skip-trust",
    installable: false,
    installed: true,
    installStatus: "installed",
    authStatus: "not-required",
    verificationStatus: "not-applicable",
  } satisfies AcpAgentSettingsEntry;
}

function grokEntry(params?: {
  activeCommand?: string;
  instances?: AcpAgentSettingsEntry["instances"];
  managedBuild?: AcpAgentSettingsEntry["managedBuild"];
}): AcpAgentSettingsEntry {
  const activeCommand = params?.activeCommand ?? "/usr/bin/grok";
  return {
    backendId: "acp:grok",
    registryId: "grok",
    name: "Grok",
    version: "1.0.0",
    authors: [],
    distributionKind: "local",
    distributionSource: `${activeCommand} --acp`,
    installable: false,
    installed: true,
    installStatus: "installed",
    authStatus: "not-required",
    verificationStatus: "not-applicable",
    instances: params?.instances ?? [
      { command: activeCommand, version: "1.0.0", source: "path" },
    ],
    activeCommand,
    ...(params?.managedBuild ? { managedBuild: params.managedBuild } : {}),
  } satisfies AcpAgentSettingsEntry;
}

const MANAGED_VERSIONS = "/Users/me/.pwragent/agents/grok/versions";

function acpSnapshot(
  registryId: "grok" | "qwen",
  cliPath: string,
  source: "config" | "env" = "config",
  enabled = true,
  managedBuilds = true,
): DesktopSettingsSnapshot {
  return {
    acpAgents: {
      [registryId]: {
        cliPath: { value: cliPath, source },
        enabled,
        ...(registryId === "grok" ? { managedBuilds } : {}),
      },
    },
  } as unknown as DesktopSettingsSnapshot;
}

describe("AcpAgentsSettings — Grok build channel", () => {
  it("names the installed PwrAgent build and when it was checked", async () => {
    const listAcpAgents = vi.fn(async () => ({
      fetchedAt: 1_000,
      entries: [
        grokEntry({
          managedBuild: {
            repository: "pwrdrvr/grok-build",
            channel: "latest" as const,
            installedTag: "pwragent-v1.0.4-pwragent.2",
            activeTag: "pwragent-v1.0.4-pwragent.2",
            checkedAt: Date.now() - 2 * 60 * 60_000,
            installedAt: Date.now() - 2 * 60 * 60_000,
          },
        }),
      ],
    }));

    render(
      <AcpAgentsSettings
        desktopApi={{ listAcpAgents } as DesktopApi}
        snapshot={acpSnapshot("grok", "")}
        onManagedGrokBuildsChange={vi.fn(async () => true)}
      />,
    );

    expect(await screen.findByText("pwragent-v1.0.4-pwragent.2"))
      .toBeInTheDocument();
    expect(screen.getByText(/checked 2h ago/)).toBeInTheDocument();
    // The channel is up to date, so there is nothing to install — PwrAgent
    // already did. Only an explicit re-check is offered.
    expect(
      screen.getByRole("button", { name: "Check for updates" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use newest build" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Release notes" }))
      .toHaveAttribute(
        "href",
        "https://github.com/pwrdrvr/grok-build/releases/tag/pwragent-v1.0.4-pwragent.2",
      );
  });

  it("offers a one-click way out of a pinned older build", async () => {
    const pinned = `${MANAGED_VERSIONS}/pwragent-v1.0.4-pwragent.2/grok`;
    const listAcpAgents = vi.fn(async () => ({
      fetchedAt: 1_000,
      entries: [
        grokEntry({
          activeCommand: pinned,
          instances: [
            {
              command: pinned,
              version: "1.0.4-pwragent.2",
              source: "override",
              pwrAgentBuild: true,
              pwrAgentBuildTag: "pwragent-v1.0.4-pwragent.2",
            },
          ],
          managedBuild: {
            repository: "pwrdrvr/grok-build",
            channel: "latest" as const,
            installedTag: "pwragent-v1.0.5-pwragent.1",
            activeTag: "pwragent-v1.0.4-pwragent.2",
            checkedAt: Date.now(),
            installedAt: Date.now(),
            pinnedBehind: true,
          },
        }),
      ],
    }));
    const onCliPathChange = vi.fn(async () => true);

    render(
      <AcpAgentsSettings
        desktopApi={{ listAcpAgents } as DesktopApi}
        snapshot={acpSnapshot("grok", pinned)}
        onCliPathChange={onCliPathChange}
        onManagedGrokBuildsChange={vi.fn(async () => true)}
      />,
    );

    expect(
      await screen.findByText(/a manual path pins pwragent-v1\.0\.4-pwragent\.2/),
    ).toBeInTheDocument();
    expect(screen.getByText(/This path pins one PwrAgent build/))
      .toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Use newest build" }));
    // Clearing the override is the whole fix: with managed builds on,
    // discovery already ranks the newest managed build ahead of everything.
    await waitFor(() => {
      expect(onCliPathChange).toHaveBeenCalledWith("grok", "");
    });
  });

  it("does not imply the newest build is running when it is not", async () => {
    const listAcpAgents = vi.fn(async () => ({
      fetchedAt: 1_000,
      entries: [
        grokEntry({
          activeCommand: "/Users/me/.grok/bin/grok",
          managedBuild: {
            repository: "pwrdrvr/grok-build",
            channel: "latest" as const,
            installedTag: "pwragent-v1.0.4-pwragent.2",
            checkedAt: Date.now(),
            installedAt: Date.now(),
          },
        }),
      ],
    }));

    render(
      <AcpAgentsSettings
        desktopApi={{ listAcpAgents } as DesktopApi}
        snapshot={acpSnapshot("grok", "/Users/me/.grok/bin/grok")}
        onManagedGrokBuildsChange={vi.fn(async () => true)}
      />,
    );

    // The newest verified build is on disk and none of it is running: an
    // operator reads "newest verified build" as "this is what my threads use".
    expect(
      await screen.findByText(/not in use, another Grok install is active/),
    ).toBeInTheDocument();
    // The row's own sub-line legitimately contains "newest verified build";
    // the status line must not.
    expect(screen.queryByText(/installed · newest verified build/))
      .not.toBeInTheDocument();
  });

  it("labels which product each detected Grok binary is", async () => {
    const managed = `${MANAGED_VERSIONS}/pwragent-v1.0.4-pwragent.2/grok`;
    const listAcpAgents = vi.fn(async () => ({
      fetchedAt: 1_000,
      entries: [
        grokEntry({
          activeCommand: managed,
          instances: [
            {
              command: managed,
              version: "1.0.4-pwragent.2",
              source: "fallback",
              pwrAgentBuild: true,
              pwrAgentBuildTag: "pwragent-v1.0.4-pwragent.2",
            },
            { command: "/Users/me/.grok/bin/grok", version: "1.0.5", source: "path" },
          ],
          managedBuild: {
            repository: "pwrdrvr/grok-build",
            channel: "latest" as const,
            installedTag: "pwragent-v1.0.4-pwragent.2",
            activeTag: "pwragent-v1.0.4-pwragent.2",
            checkedAt: Date.now(),
            installedAt: Date.now(),
          },
        }),
      ],
    }));

    render(
      <AcpAgentsSettings
        desktopApi={{ listAcpAgents } as DesktopApi}
        snapshot={acpSnapshot("grok", "")}
        onManagedGrokBuildsChange={vi.fn(async () => true)}
      />,
    );

    // Without these, "v1.0.5" next to "v1.0.4-pwragent.2" reads as one release
    // behind rather than as a different product from a different publisher.
    // Scoped to the install list: the row that configures the channel is also
    // labelled "PwrAgent build".
    const installs = await screen.findByLabelText("Grok installs");
    expect(within(installs).getByText("PwrAgent build")).toBeInTheDocument();
    expect(within(installs).getByText("xAI build")).toBeInTheDocument();
  });
});

describe("AcpAgentsSettings", () => {
  it("lets Grok users opt out of managed PwrAgent builds", async () => {
    const listAcpAgents = vi.fn(async () => ({
      fetchedAt: 1_000,
      entries: [grokEntry()],
    }));
    const onManagedGrokBuildsChange = vi.fn(async () => true);

    render(
      <AcpAgentsSettings
        desktopApi={{ listAcpAgents } as DesktopApi}
        snapshot={acpSnapshot("grok", "")}
        onManagedGrokBuildsChange={onManagedGrokBuildsChange}
      />,
    );

    const toggle = await screen.findByRole("switch", {
      name: "PwrAgent build — Grok",
    });
    await waitFor(() => expect(toggle).toBeEnabled());
    toggle.click();

    await waitFor(() => {
      expect(onManagedGrokBuildsChange).toHaveBeenCalledWith(false);
      expect(listAcpAgents).toHaveBeenCalledWith({
        discoveryIntent: "settings-user-action",
        refresh: true,
        force: true,
      });
    });
  });

  it("refreshes backend summaries after capability discovery completes", async () => {
    const onBackendSummariesRefresh = vi.fn();
    window.addEventListener(
      BACKEND_SUMMARIES_REFRESH_EVENT,
      onBackendSummariesRefresh,
    );
    const listAcpAgents = vi.fn(
      async (_request?: { refresh?: boolean; force?: boolean }) => ({
        fetchedAt: 1000,
        entries: [geminiEntry()],
      }),
    );

    render(<AcpAgentsSettings desktopApi={{ listAcpAgents } as DesktopApi} />);

    fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(onBackendSummariesRefresh).toHaveBeenCalledTimes(1);
    });
    window.removeEventListener(
      BACKEND_SUMMARIES_REFRESH_EVENT,
      onBackendSummariesRefresh,
    );
  });

  it("hides a stale Claude entry when its Experimental opt-in is off", async () => {
    const listAcpAgents = vi.fn(async () => ({
      fetchedAt: 1000,
      entries: [claudeEntry(false)],
    }));
    const snapshot = {
      experimental: {
        claudeAcp: { value: false, source: "default" },
      },
    } as DesktopSettingsSnapshot;

    render(
      <AcpAgentsSettings
        desktopApi={{ listAcpAgents } as DesktopApi}
        snapshot={snapshot}
      />,
    );

    await waitFor(() => {
      expect(listAcpAgents).toHaveBeenCalled();
    });
    expect(screen.queryByText("Claude Agent")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Install Claude adapter" }),
    ).not.toBeInTheDocument();
  });

  it("installs the pinned Claude runtime and surfaces local auth choices", async () => {
    const placeholder = claudeEntry(false);
    const installed = claudeEntry(true);
    const listAcpAgents = vi.fn(async () => ({
      fetchedAt: 1000,
      entries: [placeholder],
    }));
    const installAcpAgent = vi.fn(async () => ({
      fetchedAt: 2000,
      entry: installed,
    }));

    render(
      <AcpAgentsSettings
        desktopApi={{ listAcpAgents, installAcpAgent } as DesktopApi}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Install Claude adapter" }),
    );
    await waitFor(() => {
      expect(installAcpAgent).toHaveBeenCalledWith({
        registryId: "claude-acp",
        expectedVersion: "0.60.0",
      });
    });
    expect(
      await screen.findByText(/Subscription use through a third-party product/),
    ).toBeInTheDocument();
    expect(screen.getByText(/--cli auth login --console/)).toBeInTheDocument();
    expect(screen.getByText(/--cli auth login --claudeai/)).toBeInTheDocument();
    expect(screen.getByText("Owning instance only")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Check readiness" }));
    await waitFor(() => {
      expect(listAcpAgents).toHaveBeenCalledWith({ refresh: true, force: true });
    });
  });

  it("surfaces an unexpected managed install failure as a retryable state", async () => {
    const listAcpAgents = vi.fn(async () => ({
      fetchedAt: 1000,
      entries: [claudeEntry(false)],
    }));
    const installAcpAgent = vi.fn(async () => {
      throw new Error("npm registry unavailable");
    });

    render(
      <AcpAgentsSettings
        desktopApi={{ listAcpAgents, installAcpAgent } as DesktopApi}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Install Claude adapter" }),
    );

    expect(
      await screen.findByRole("button", { name: "Retry install" }),
    ).toBeInTheDocument();
    expect(screen.getByText("npm registry unavailable")).toHaveAttribute(
      "role",
      "alert",
    );
    expect(screen.getByText("Install failed")).toBeInTheDocument();
  });

  it("keeps cached ACP agents visible while explicit discovery refreshes", async () => {
    const dispatchEvent = vi.spyOn(window, "dispatchEvent");
    let resolveRefresh:
      | ((value: { fetchedAt: number; entries: AcpAgentSettingsEntry[] }) => void)
      | undefined;
    const refreshPromise = new Promise<{
      fetchedAt: number;
      entries: AcpAgentSettingsEntry[];
    }>((resolve) => {
      resolveRefresh = resolve;
    });
    const cachedEntry = {
      backendId: "acp:gemini",
      registryId: "gemini",
      name: "Gemini CLI",
      version: "0.42.0",
      authors: [],
      distributionKind: "local",
      distributionSource: "gemini --acp --skip-trust",
      installable: false,
      installed: true,
      installStatus: "installed",
      authStatus: "not-required",
      verificationStatus: "not-applicable",
      instances: [{ command: "gemini", version: "0.42.0", source: "path" }],
      activeCommand: "gemini",
      lastDiscoveredAt: 1779400000000,
      lastDiscoveryError: "previous probe failed",
      runtime: {
        schemaVersion: 1,
        status: "discovered",
        discoveredAt: 1779400000000,
        checkedAt: 1779400000000,
        source: "session-load",
        protocolVersion: 1,
        configOptions: [
          {
            id: "approval-mode",
            label: "Permission mode",
            type: "select",
            category: "mode",
            currentValue: "default",
            values: [{ value: "default", label: "Default" }],
          },
        ],
        models: {
          currentModelId: "gemini-3-flash-preview",
          availableModels: [
            { id: "gemini-3-flash-preview", label: "Gemini 3 Flash" },
          ],
        },
      },
    } satisfies AcpAgentSettingsEntry;
    const listAcpAgents = vi.fn(
      async (request?: { refresh?: boolean }) =>
        request?.refresh
          ? refreshPromise
          : { fetchedAt: 1000, entries: [cachedEntry] },
    );

    render(<AcpAgentsSettings desktopApi={{ listAcpAgents } as DesktopApi} />);

    expect(await screen.findByText("Gemini CLI")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(listAcpAgents).toHaveBeenCalledWith({
        discoveryIntent: "settings-user-action",
        force: true,
        refresh: true,
      });
    });
    // The agent's section shows its discovered install with the "Using" badge
    // and stays visible while the registry refresh is in flight.
    expect(screen.getByText("gemini")).toBeInTheDocument();
    expect(screen.getByText("Using")).toBeInTheDocument();
    expect(screen.getByText("previous probe failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discovering…" })).toBeDisabled();

    resolveRefresh?.({ fetchedAt: 2000, entries: [cachedEntry] });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
    });
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: BACKEND_SUMMARIES_REFRESH_EVENT,
      }),
    );
  });

  it("renders multiple installs with a 'Use' action and the active one as 'Using'", async () => {
    const onCliPathChange = vi.fn(async () => true);
    const desktopApi: DesktopApi = {
      listAcpAgents: vi.fn(async () => ({
        fetchedAt: 1000,
        entries: [
          {
            backendId: "acp:qwen",
            registryId: "qwen",
            name: "Qwen Code",
            version: "0.17.0",
            authors: ["Qwen Team"],
            distributionKind: "local",
            distributionSource: "/usr/bin/qwen --acp",
            installable: false,
            installed: true,
            installStatus: "installed",
            authStatus: "not-required",
            verificationStatus: "not-applicable",
            instances: [
              { command: "/usr/bin/qwen", version: "0.17.0", source: "path" },
              { command: "/opt/homebrew/bin/qwen", version: "0.16.0", source: "path" },
            ],
            activeCommand: "/usr/bin/qwen",
          } satisfies AcpAgentSettingsEntry,
        ],
      })),
    };

    render(
      <AcpAgentsSettings desktopApi={desktopApi} onCliPathChange={onCliPathChange} />,
    );

    expect(await screen.findByText("Qwen Code")).toBeInTheDocument();
    // Both installs render as path rows; "2 found" labels the install field.
    expect(screen.getByText("2 found")).toBeInTheDocument();
    expect(screen.getByText("/usr/bin/qwen")).toBeInTheDocument();
    expect(screen.getByText("/opt/homebrew/bin/qwen")).toBeInTheDocument();
    // The active install shows "Using"; the other offers a "Use" action that
    // pins it by writing its command as the cliPath override.
    expect(screen.getByText("Using")).toBeInTheDocument();
    screen.getByRole("button", { name: "Use" }).click();
    expect(onCliPathChange).toHaveBeenCalledWith("qwen", "/opt/homebrew/bin/qwen");
    await waitFor(() => {
      expect(desktopApi.listAcpAgents).toHaveBeenCalledWith({
        discoveryIntent: "settings-user-action",
        refresh: true,
        force: true,
      });
    });
  });

  it("blocks path changes while provider discovery is running", async () => {
    const installed = grokEntry({
      instances: [
        { command: "/usr/bin/grok", version: "1.0.0", source: "path" },
        { command: "/opt/homebrew/bin/grok", version: "0.9.0", source: "path" },
      ],
    });
    let resolveManualRefresh:
      | ((value: { fetchedAt: number; entries: AcpAgentSettingsEntry[] }) => void)
      | undefined;
    const manualRefresh = new Promise<{
      fetchedAt: number;
      entries: AcpAgentSettingsEntry[];
    }>((resolve) => {
      resolveManualRefresh = resolve;
    });
    const listAcpAgents = vi.fn(
      async (request?: { refresh?: boolean; force?: boolean }) =>
        request?.force
          ? manualRefresh
          : { fetchedAt: 1000, entries: [installed] },
    );
    const onCliPathChange = vi.fn(async () => true);

    render(
      <AcpAgentsSettings
        desktopApi={{ listAcpAgents } as DesktopApi}
        snapshot={acpSnapshot("grok", "")}
        onCliPathChange={onCliPathChange}
      />,
    );

    expect(await screen.findByText("Grok")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
    });
    fireEvent.change(screen.getByLabelText("Grok manual path"), {
      target: { value: "/Users/me/bin/grok-next" },
    });
    screen.getByRole("button", { name: "Refresh" }).click();

    expect(
      await screen.findByRole("button", { name: "Discovering…" }),
    ).toBeDisabled();
    expect(screen.getByLabelText("Grok manual path")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Use" })).toBeDisabled();
    expect(onCliPathChange).not.toHaveBeenCalled();

    resolveManualRefresh?.({ fetchedAt: 2000, entries: [installed] });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    });
  });

  it("saves and immediately verifies a manual path for new threads", async () => {
    const overridePath = "/Users/me/.local/bin/grok-local";
    const installed = grokEntry();
    const overridden = grokEntry({
      activeCommand: overridePath,
      instances: [
        { command: overridePath, version: "2.0.0", source: "override" },
        { command: "/usr/bin/grok", version: "1.0.0", source: "path" },
      ],
    });
    const listAcpAgents = vi.fn(
      async (request?: { refresh?: boolean; force?: boolean }) => ({
        fetchedAt: 1000,
        entries: [request?.force ? overridden : installed],
      }),
    );

    function Harness() {
      const [snapshot, setSnapshot] = useState(acpSnapshot("grok", ""));
      return (
        <AcpAgentsSettings
          desktopApi={{ listAcpAgents } as DesktopApi}
          snapshot={snapshot}
          onCliPathChange={async (registryId, cliPath) => {
            setSnapshot(acpSnapshot(registryId as "grok", cliPath));
            return true;
          }}
        />
      );
    }

    render(<Harness />);

    expect(await screen.findByText("Grok")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
    });
    fireEvent.change(screen.getByLabelText("Grok manual path"), {
      target: { value: overridePath },
    });
    screen.getByRole("button", { name: "Save" }).click();

    await waitFor(() => {
      expect(listAcpAgents).toHaveBeenCalledWith({
        discoveryIntent: "settings-user-action",
        refresh: true,
        force: true,
      });
    });
    expect(await screen.findByText("active override")).toBeInTheDocument();
    expect(screen.getByText("override")).toBeInTheDocument();
    expect(screen.getByText("v2.0.0")).toBeInTheDocument();
    expect(
      screen.getByText("Active for new threads · v2.0.0."),
    ).toBeInTheDocument();
    expect(screen.getByText(overridePath)).toBeInTheDocument();
    expect(screen.getByText("Using")).toBeInTheDocument();
  });

  it("shows when a saved manual path is not active and names the fallback", async () => {
    const invalidPath = "/Users/me/bin/missing-grok";
    const installed = grokEntry();
    const listAcpAgents = vi.fn(async () => ({
      fetchedAt: 1000,
      entries: [installed],
    }));

    function Harness() {
      const [snapshot, setSnapshot] = useState(acpSnapshot("grok", ""));
      return (
        <AcpAgentsSettings
          desktopApi={{ listAcpAgents } as DesktopApi}
          snapshot={snapshot}
          onCliPathChange={async (registryId, cliPath) => {
            setSnapshot(acpSnapshot(registryId as "grok", cliPath));
            return true;
          }}
        />
      );
    }

    render(<Harness />);

    expect(await screen.findByText("Grok")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
    });
    fireEvent.change(screen.getByLabelText("Grok manual path"), {
      target: { value: invalidPath },
    });
    screen.getByRole("button", { name: "Save" }).click();

    expect(
      await screen.findByText(
        "Saved override is not active. New threads currently use /usr/bin/grok.",
      ),
    ).toHaveAttribute("role", "alert");
    expect(screen.getByText("saved override")).toBeInTheDocument();
    expect(screen.getByLabelText("Grok manual path")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("preserves a saved path when verification fails and supports retry", async () => {
    const overridePath = "/Users/me/.local/bin/grok-local";
    const installed = grokEntry();
    const overridden = grokEntry({
      activeCommand: overridePath,
      instances: [
        { command: overridePath, version: "2.0.0", source: "override" },
        { command: "/usr/bin/grok", version: "1.0.0", source: "path" },
      ],
    });
    let forcedAttempts = 0;
    const listAcpAgents = vi.fn(
      async (request?: { refresh?: boolean; force?: boolean }) => {
        if (request?.force) {
          forcedAttempts += 1;
          if (forcedAttempts === 1) {
            throw new Error("probe unavailable");
          }
          return { fetchedAt: 2000, entries: [overridden] };
        }
        return { fetchedAt: 1000, entries: [installed] };
      },
    );

    function Harness() {
      const [snapshot, setSnapshot] = useState(acpSnapshot("grok", ""));
      return (
        <AcpAgentsSettings
          desktopApi={{ listAcpAgents } as DesktopApi}
          snapshot={snapshot}
          onCliPathChange={async (registryId, cliPath) => {
            setSnapshot(acpSnapshot(registryId as "grok", cliPath));
            return true;
          }}
        />
      );
    }

    render(<Harness />);

    expect(await screen.findByText("Grok")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
    });
    fireEvent.change(screen.getByLabelText("Grok manual path"), {
      target: { value: overridePath },
    });
    screen.getByRole("button", { name: "Save" }).click();

    expect(
      await screen.findByText(
        "Path was saved, but PwrAgent couldn't verify it. Click Refresh to try again.",
      ),
    ).toHaveAttribute("role", "alert");
    expect(screen.getByLabelText("Grok manual path")).toHaveValue(overridePath);
    expect(screen.getByText("saved override")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    screen.getByRole("button", { name: "Refresh" }).click();
    expect(
      await screen.findByText("Active for new threads · v2.0.0."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Path was saved, but PwrAgent couldn't verify it. Click Refresh to try again.",
      ),
    ).not.toBeInTheDocument();
  });

  it("does not claim a saved path is active while the provider is disabled", async () => {
    const overridePath = "/Users/me/.local/bin/grok-local";
    const entry = grokEntry({
      activeCommand: overridePath,
      instances: [
        { command: overridePath, version: "2.0.0", source: "override" },
      ],
    });
    const listAcpAgents = vi.fn(async () => ({
      fetchedAt: 1000,
      entries: [entry],
    }));

    render(
      <AcpAgentsSettings
        desktopApi={{ listAcpAgents } as DesktopApi}
        snapshot={acpSnapshot("grok", overridePath, "config", false)}
        onCliPathChange={vi.fn(async () => true)}
      />,
    );

    expect(await screen.findByText("Grok")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
    });
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.getByText("saved override")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Enable this provider, then click Refresh to verify the saved path before use.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("active override")).not.toBeInTheDocument();
    expect(screen.queryByText("Using")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Active for new threads · v2.0.0."),
    ).not.toBeInTheDocument();
  });

  it("makes environment-forced paths read-only and explains their source", async () => {
    const envPath = "/opt/company/bin/grok";
    const entry = grokEntry({
      activeCommand: envPath,
      instances: [{ command: envPath, version: "1.2.3", source: "override" }],
    });
    const listAcpAgents = vi.fn(async () => ({
      fetchedAt: 1000,
      entries: [entry],
    }));

    render(
      <AcpAgentsSettings
        desktopApi={{ listAcpAgents } as DesktopApi}
        snapshot={acpSnapshot("grok", envPath, "env")}
        onCliPathChange={vi.fn(async () => true)}
      />,
    );

    expect(await screen.findByText("Grok")).toBeInTheDocument();
    expect(screen.getByText("env override")).toBeInTheDocument();
    expect(screen.getByLabelText("Grok manual path")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
  });

  it("renders an undiscovered provider as a 'Not installed' section", async () => {
    // A known provider with no discovered installs (the placeholder main emits
    // so the section always shows) renders its own heading, a "Not installed"
    // status chip, and an empty install list — it does not vanish.
    const desktopApi = {
      listAcpAgents: vi.fn(async () => ({
        fetchedAt: 1000,
        entries: [
          {
            backendId: "acp:kimi",
            registryId: "kimi",
            name: "Kimi Code",
            authors: [],
            distributionKind: "local",
            distributionSource: "kimi (not installed)",
            installable: false,
            installed: false,
            installStatus: "not-installed",
            authStatus: "not-required",
            verificationStatus: "unverified-allowed",
            instances: [],
          } satisfies AcpAgentSettingsEntry,
        ],
      })),
    } as unknown as DesktopApi;

    render(<AcpAgentsSettings desktopApi={desktopApi} />);

    expect(await screen.findByText("Kimi Code")).toBeInTheDocument();
    expect(screen.getByText("Not installed")).toBeInTheDocument();
    expect(screen.getByText("Not installed.")).toBeInTheDocument();
  });

  it("renders only the requested agent on a focused provider screen", async () => {
    const listAcpAgents = vi.fn(async () => ({
      fetchedAt: 1000,
      entries: [grokEntry(), geminiEntry()],
    }));

    render(
      <AcpAgentsSettings
        desktopApi={{ listAcpAgents } as DesktopApi}
        only="gemini"
      />,
    );

    expect(await screen.findByText("Gemini CLI")).toBeInTheDocument();
    expect(screen.queryByText("Grok")).not.toBeInTheDocument();
    expect(listAcpAgents).toHaveBeenCalledExactlyOnceWith({ refresh: false });

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(listAcpAgents).toHaveBeenLastCalledWith({
        discoveryIntent: "settings-user-action",
        force: true,
        refresh: true,
        registryIds: ["gemini"],
      });
    });
  });

  it("says the provider is unavailable when the focused agent is missing", async () => {
    const listAcpAgents = vi.fn(async () => ({
      fetchedAt: 1000,
      entries: [grokEntry()],
    }));

    render(
      <AcpAgentsSettings
        desktopApi={{ listAcpAgents } as DesktopApi}
        only="qwen"
      />,
    );

    expect(
      await screen.findByText("This provider is unavailable right now."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Grok")).not.toBeInTheDocument();
  });

  it("surfaces a detected CLI that failed ACP verification", async () => {
    const rejectedPath = "/usr/local/bin/qwen";
    const desktopApi = {
      listAcpAgents: vi.fn(async () => ({
        fetchedAt: 1000,
        entries: [
          {
            backendId: "acp:qwen",
            registryId: "qwen",
            name: "Qwen Code",
            authors: [],
            distributionKind: "local",
            distributionSource: `${rejectedPath} (ACP verification failed)`,
            installable: false,
            installed: false,
            installStatus: "unavailable",
            authStatus: "not-required",
            verificationStatus: "not-applicable",
            lastError: `${rejectedPath} was found, but PwrAgent could not verify ACP support.`,
            instances: [],
            rejectedInstances: [
              {
                command: rejectedPath,
                version: "0.21.0",
                source: "path",
                reason: "acp-probe-failed",
              },
            ],
          } satisfies AcpAgentSettingsEntry,
        ],
      })),
    } as unknown as DesktopApi;

    render(<AcpAgentsSettings desktopApi={desktopApi} />);

    expect(await screen.findByText("Qwen Code")).toBeInTheDocument();
    expect(screen.getByText("Detected · unavailable")).toBeInTheDocument();
    expect(screen.getByText(rejectedPath)).toBeInTheDocument();
    expect(screen.getByText("ACP check failed")).toBeInTheDocument();
    expect(
      screen.getByText(
        `${rejectedPath} was found, but PwrAgent could not verify ACP support.`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Not installed.")).not.toBeInTheDocument();
  });

  it("surfaces a timed-out ACP verification as retryable", async () => {
    const timedOutPath = "/usr/local/bin/qwen";
    const desktopApi = {
      listAcpAgents: vi.fn(async () => ({
        fetchedAt: 1000,
        entries: [
          {
            backendId: "acp:qwen",
            registryId: "qwen",
            name: "Qwen Code",
            authors: [],
            distributionKind: "local",
            distributionSource: `${timedOutPath} (ACP verification timed out)`,
            installable: false,
            installed: false,
            installStatus: "unavailable",
            authStatus: "not-required",
            verificationStatus: "not-applicable",
            lastError: `${timedOutPath} was found, but its ACP verification timed out. Refresh to try again.`,
            instances: [],
            rejectedInstances: [
              {
                command: timedOutPath,
                version: "0.21.0",
                source: "path",
                reason: "probe-timed-out",
              },
            ],
          } satisfies AcpAgentSettingsEntry,
        ],
      })),
    } as unknown as DesktopApi;

    render(<AcpAgentsSettings desktopApi={desktopApi} />);

    expect(await screen.findByText("Qwen Code")).toBeInTheDocument();
    expect(screen.getByText("Detected · check timed out")).toBeInTheDocument();
    expect(screen.getByText(timedOutPath)).toBeInTheDocument();
    expect(screen.getByText("ACP check timed out")).toBeInTheDocument();
    expect(
      screen.getByText(
        `${timedOutPath} was found, but its ACP verification timed out. Refresh to try again.`,
      ),
    ).toBeInTheDocument();
  });

  it("renders a durable remediation card for legacy Python kimi-cli", async () => {
    const legacyPath = "/Users/me/.local/bin/kimi";
    const rejectedPath = "/Users/me/bin/not-kimi";
    const desktopApi = {
      listAcpAgents: vi.fn(async () => ({
        fetchedAt: 1000,
        entries: [
          {
            backendId: "acp:kimi",
            registryId: "kimi",
            name: "Kimi Code CLI",
            version: "1.46.0",
            authors: ["Moonshot AI"],
            distributionKind: "local",
            distributionSource: `${legacyPath} (legacy kimi-cli ignored)`,
            installable: false,
            installed: false,
            installStatus: "unavailable",
            authStatus: "not-required",
            verificationStatus: "not-applicable",
            instances: [],
            incompatibleInstances: [
              { command: legacyPath, version: "1.46.0", source: "path" },
            ],
            rejectedInstances: [
              {
                command: rejectedPath,
                source: "override",
                reason: "acp-probe-failed",
              },
            ],
          } satisfies AcpAgentSettingsEntry,
        ],
      })),
    } as unknown as DesktopApi;

    render(<AcpAgentsSettings desktopApi={desktopApi} />);

    expect(
      await screen.findByText("Current Kimi Code required"),
    ).toBeInTheDocument();
    expect(screen.getByText("Action required")).toBeInTheDocument();
    expect(screen.getByText(legacyPath)).toBeInTheDocument();
    expect(screen.getByText("legacy Python")).toBeInTheDocument();
    expect(screen.getByText(rejectedPath)).toBeInTheDocument();
    expect(screen.getByText("ACP check failed")).toBeInTheDocument();
    expect(
      screen.getByText(
        "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open install guide" }),
    ).toHaveAttribute(
      "href",
      "https://www.kimi.com/help/kimi-code/cli-getting-started",
    );
  });

  it("performs one cache-only read under StrictMode's double-invoked mount effect", async () => {
    const listAcpAgents = vi.fn(
      async (_request?: { refresh?: boolean; force?: boolean }) => ({
        fetchedAt: 1000,
        entries: [geminiEntry()],
      }),
    );

    render(
      <StrictMode>
        <AcpAgentsSettings desktopApi={{ listAcpAgents } as DesktopApi} />
      </StrictMode>,
    );

    expect(await screen.findByText("Gemini CLI")).toBeInTheDocument();
    // StrictMode runs the mount effect twice in dev; the did-initial-load ref
    // collapses it into one cache read and must never turn mount into discovery.
    await waitFor(() => {
      expect(listAcpAgents).toHaveBeenCalledExactlyOnceWith({ refresh: false });
    });
  });

  it("loads once the desktop API bridge becomes available after mount", async () => {
    const listAcpAgents = vi.fn(
      async (_request?: { refresh?: boolean; force?: boolean }) => ({
        fetchedAt: 1000,
        entries: [geminiEntry()],
      }),
    );

    // useDesktopApi resolves the bridge asynchronously, so this pane can mount
    // with `desktopApi` still undefined. It should surface the unavailable
    // state without latching the initial-load ref.
    const { rerender } = render(<AcpAgentsSettings desktopApi={undefined} />);
    expect(
      await screen.findByText(
        "ACP registry controls are unavailable in this build.",
      ),
    ).toBeInTheDocument();
    expect(listAcpAgents).not.toHaveBeenCalled();

    // When the bridge arrives the effect must re-run and load — not stay stuck
    // on the unavailable error (the regression the un-latched guard prevents).
    rerender(<AcpAgentsSettings desktopApi={{ listAcpAgents } as DesktopApi} />);
    expect(await screen.findByText("Gemini CLI")).toBeInTheDocument();
    await waitFor(() => {
      expect(listAcpAgents).toHaveBeenCalledExactlyOnceWith({ refresh: false });
    });
    expect(
      screen.queryByText(
        "ACP registry controls are unavailable in this build.",
      ),
    ).not.toBeInTheDocument();
  });

  it("names both build tracks and writes the one the operator picks", async () => {
    const listAcpAgents = vi.fn(async () => ({
      fetchedAt: 1_000,
      entries: [
        grokEntry({
          managedBuild: {
            repository: "pwrdrvr/grok-build",
            channel: "latest" as const,
            latestTag: "pwragent-v1.0.4-pwragent.2",
            prereleaseTag: "pwragent-v1.0.5-pwragent.1",
            installedTag: "pwragent-v1.0.4-pwragent.2",
            activeTag: "pwragent-v1.0.4-pwragent.2",
            checkedAt: 1_000,
            installedAt: 1_000,
          },
        }),
      ],
    }));
    const onManagedGrokBuildChannelChange = vi.fn(async () => true);

    render(
      <AcpAgentsSettings
        desktopApi={{ listAcpAgents } as DesktopApi}
        snapshot={acpSnapshot("grok", "")}
        onManagedGrokBuildsChange={vi.fn(async () => true)}
        onManagedGrokBuildChannelChange={onManagedGrokBuildChannelChange}
      />,
    );

    const track = await screen.findByRole("radiogroup", { name: "Build track" });
    // Each track names the version it resolves to, so the operator can see
    // what switching would actually get them before they switch.
    expect(within(track).getByText("1.0.4-pwragent.2")).toBeInTheDocument();
    expect(within(track).getByText("1.0.5-pwragent.1")).toBeInTheDocument();
    expect(within(track).getByRole("radio", { name: /Latest/ }))
      .toHaveAttribute("aria-checked", "true");

    fireEvent.click(within(track).getByRole("radio", { name: /Prerelease/ }));
    await waitFor(() => {
      expect(onManagedGrokBuildChannelChange)
        .toHaveBeenCalledExactlyOnceWith("prerelease");
    });
  });

  it("follows the track the config holds, not the last discovery", async () => {
    // A switch writes the config, then rescans. If the rescan fails — offline,
    // or the forced release check throws — the control must still show the
    // track that was written, not snap back and claim the write did not take.
    const listAcpAgents = vi.fn(async () => ({
      fetchedAt: 1_000,
      entries: [
        grokEntry({
          managedBuild: {
            repository: "pwrdrvr/grok-build",
            channel: "latest" as const,
            latestTag: "pwragent-v1.0.4-pwragent.2",
            prereleaseTag: "pwragent-v1.0.5-pwragent.1",
            installedTag: "pwragent-v1.0.4-pwragent.2",
            activeTag: "pwragent-v1.0.4-pwragent.2",
            checkedAt: 1_000,
            installedAt: 1_000,
          },
        }),
      ],
    }));
    const snapshot = acpSnapshot("grok", "");
    (
      snapshot.acpAgents as unknown as {
        grok: { managedBuildChannel?: string };
      }
    ).grok.managedBuildChannel = "prerelease";

    render(
      <AcpAgentsSettings
        desktopApi={{ listAcpAgents } as DesktopApi}
        snapshot={snapshot}
        onManagedGrokBuildsChange={vi.fn(async () => true)}
        onManagedGrokBuildChannelChange={vi.fn(async () => true)}
      />,
    );

    const track = await screen.findByRole("radiogroup", { name: "Build track" });
    expect(within(track).getByRole("radio", { name: /Prerelease/ }))
      .toHaveAttribute("aria-checked", "true");
    expect(within(track).getByRole("radio", { name: /Latest/ }))
      .toHaveAttribute("aria-checked", "false");
  });

  it("keeps Prerelease selectable when both tracks are the same build", async () => {
    // Between publishing a build and promoting it the tracks agree. The
    // control still has to be usable: this is exactly when an operator moves
    // onto Prerelease to pick up the next test build.
    const listAcpAgents = vi.fn(async () => ({
      fetchedAt: 1_000,
      entries: [
        grokEntry({
          managedBuild: {
            repository: "pwrdrvr/grok-build",
            channel: "latest" as const,
            latestTag: "pwragent-v1.0.5-pwragent.1",
            prereleaseTag: "pwragent-v1.0.5-pwragent.1",
            installedTag: "pwragent-v1.0.5-pwragent.1",
            activeTag: "pwragent-v1.0.5-pwragent.1",
            checkedAt: 1_000,
            installedAt: 1_000,
          },
        }),
      ],
    }));

    render(
      <AcpAgentsSettings
        desktopApi={{ listAcpAgents } as DesktopApi}
        snapshot={acpSnapshot("grok", "")}
        onManagedGrokBuildsChange={vi.fn(async () => true)}
        onManagedGrokBuildChannelChange={vi.fn(async () => true)}
      />,
    );

    const track = await screen.findByRole("radiogroup", { name: "Build track" });
    expect(within(track).getByRole("radio", { name: /Prerelease/ }))
      .toBeEnabled();
    expect(within(track).getAllByText("1.0.5-pwragent.1")).toHaveLength(2);
  });

  it("renders Gemini CLI last even though the catalog lists it first", async () => {
    const listAcpAgents = vi.fn(async () => ({
      fetchedAt: 1_000,
      entries: [geminiEntry(), grokEntry()],
    }));

    render(<AcpAgentsSettings desktopApi={{ listAcpAgents } as DesktopApi} />);

    await screen.findByText("Gemini CLI");
    const headings = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual(["Grok", "Gemini CLI"]);
  });
});

function claudeEntry(installed: boolean): AcpAgentSettingsEntry {
  return {
    backendId: "acp:claude-acp",
    registryId: "claude-acp",
    name: "Claude Agent",
    version: "0.60.0",
    authors: ["Agent Client Protocol contributors"],
    distributionKind: "npx",
    distributionSource: "@agentclientprotocol/claude-agent-acp@0.60.0",
    installable: true,
    installed,
    installStatus: installed ? "installed" : "not-installed",
    authStatus: "required",
    verificationStatus: "verified",
    allowlistRuleId: "managed-claude-agent-acp-0.60.0",
    managedRuntime: {
      kind: "pwragent-managed",
      packageName: "@agentclientprotocol/claude-agent-acp",
      pinnedVersion: "0.60.0",
      integrity: "sha512-test",
      credentialScope: "owning-instance",
      supportLevel: "experimental",
      authMethod: "local-terminal",
      subscriptionAuthBlocked: false,
      ...(installed
        ? {
            consoleAuthCommand:
              "/usr/bin/node /profile/claude-agent-acp/dist/index.js --cli auth login --console",
            subscriptionAuthCommand:
              "/usr/bin/node /profile/claude-agent-acp/dist/index.js --cli auth login --claudeai",
          }
        : {}),
    },
  };
}
