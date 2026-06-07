import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpAgentSettingsEntry } from "@pwragent/shared";
import { AcpAgentsSettings } from "../AcpAgentsSettings";
import type { DesktopApi } from "../../../lib/desktop-api";

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

describe("AcpAgentsSettings", () => {
  it("keeps cached ACP agents visible while background discovery refreshes", async () => {
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
  });

  it("renders multiple installs with a 'Use' action and the active one as 'Using'", async () => {
    const onCliPathChange = vi.fn(async () => undefined);
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
