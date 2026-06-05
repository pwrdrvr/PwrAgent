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
    expect(screen.getByText("Gemini 3 Flash")).toBeInTheDocument();
    expect(screen.getByText("Permission mode")).toBeInTheDocument();
    expect(screen.getByText("Discovered · session-load")).toBeInTheDocument();
    expect(screen.getByText("previous probe failed")).toBeInTheDocument();
    expect(screen.queryByText("No discovered ACP agents found.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discovering..." })).toBeDisabled();

    resolveRefresh?.({ fetchedAt: 2000, entries: [cachedEntry] });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Discover new" })).toBeEnabled();
    });
  });

  it("renders discovered ACP agents with provenance", async () => {
    const desktopApi: DesktopApi = {
      listAcpAgents: vi.fn(async () => ({
        fetchedAt: 1000,
        entries: [
          {
            backendId: "acp:gemini",
            registryId: "gemini",
            name: "Gemini CLI",
            description: "Gemini over ACP",
            version: "0.42.0",
            license: "Apache-2.0",
            authors: ["Google"],
            repositoryUrl: "https://github.com/google-gemini/gemini-cli",
            distributionKind: "npx",
            distributionSource: "@google/gemini-cli@0.42.0",
            installable: false,
            installed: false,
            installStatus: "unavailable",
            authStatus: "not-required",
            verificationStatus: "not-applicable",
          } satisfies AcpAgentSettingsEntry,
        ],
      })),
    };

    render(<AcpAgentsSettings desktopApi={desktopApi} />);

    expect(await screen.findByText("Gemini CLI")).toBeInTheDocument();
    expect(screen.getByText("Apache-2.0")).toBeInTheDocument();
    expect(screen.getByText(/@google\/gemini-cli/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /install/i })).not.toBeInTheDocument();
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
