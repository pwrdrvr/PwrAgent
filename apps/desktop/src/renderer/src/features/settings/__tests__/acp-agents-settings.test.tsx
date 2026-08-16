import "@testing-library/jest-dom/vitest";
import { StrictMode, useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
  } satisfies AcpAgentSettingsEntry;
}

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
      name: "Use managed PwrAgent Grok builds",
    });
    await waitFor(() => expect(toggle).toBeEnabled());
    toggle.click();

    await waitFor(() => {
      expect(onManagedGrokBuildsChange).toHaveBeenCalledWith(false);
      expect(listAcpAgents).toHaveBeenCalledWith({ refresh: true, force: true });
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

    await waitFor(() => {
      expect(onBackendSummariesRefresh).toHaveBeenCalledTimes(1);
    });
    window.removeEventListener(
      BACKEND_SUMMARIES_REFRESH_EVENT,
      onBackendSummariesRefresh,
    );
  });

  it("keeps cached ACP agents visible while background discovery refreshes", async () => {
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
    await waitFor(() => {
      expect(listAcpAgents).toHaveBeenCalledWith({ refresh: true });
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
      expect(listAcpAgents).toHaveBeenCalledWith({ refresh: true, force: true });
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

  it("loads exactly once under StrictMode's double-invoked mount effect", async () => {
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
    // must collapse that into a single gated registry refresh (one
    // refresh: true), not two parallel discovery passes that storm the agents.
    await waitFor(() => {
      expect(
        listAcpAgents.mock.calls.filter((call) => call[0]?.refresh === true),
      ).toHaveLength(1);
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
      expect(listAcpAgents).toHaveBeenCalledWith({ refresh: true });
    });
    expect(
      screen.queryByText(
        "ACP registry controls are unavailable in this build.",
      ),
    ).not.toBeInTheDocument();
  });
});
