import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpAgentSettingsEntry } from "@pwragent/shared";
import { AcpAgentsSettings } from "../AcpAgentsSettings";
import type { DesktopApi } from "../../../lib/desktop-api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
    expect(screen.queryByText("No allowlisted ACP agents found.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discovering..." })).toBeDisabled();

    resolveRefresh?.({ fetchedAt: 2000, entries: [cachedEntry] });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Discover new" })).toBeEnabled();
    });
  });

  it("renders allowlisted ACP agents with provenance before install", async () => {
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
            installable: true,
            installed: false,
            installStatus: "not-installed",
            authStatus: "not-required",
            verificationStatus: "not-applicable",
            allowlistRuleId: "gemini-v0.42.0-npx",
          } satisfies AcpAgentSettingsEntry,
        ],
      })),
    };

    render(<AcpAgentsSettings desktopApi={desktopApi} />);

    expect(await screen.findByText("Gemini CLI")).toBeInTheDocument();
    expect(screen.getByText("Apache-2.0")).toBeInTheDocument();
    expect(screen.getByText(/@google\/gemini-cli/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review install" })).toBeEnabled();
  });

  it("requires confirmation before invoking install", async () => {
    const installAcpAgent = vi.fn(async () => ({ ok: true, fetchedAt: 1000 }));
    const listAcpAgents = vi.fn(async () => ({
      fetchedAt: 1000,
      entries: [
        {
          backendId: "acp:gemini",
          registryId: "gemini",
          name: "Gemini",
          authors: [],
          distributionKind: "npx",
          distributionSource: "@google/gemini-cli",
          installable: true,
          installed: false,
          installStatus: "not-installed",
          authStatus: "required",
          verificationStatus: "not-applicable",
        } satisfies AcpAgentSettingsEntry,
      ],
    }));
    const desktopApi = {
      listAcpAgents,
      installAcpAgent,
    } as unknown as DesktopApi;

    render(<AcpAgentsSettings desktopApi={desktopApi} />);

    fireEvent.click(await screen.findByRole("button", { name: "Review install" }));
    expect(installAcpAgent).not.toHaveBeenCalled();
    expect(screen.getByText(/third-party ACP agent/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => {
      expect(installAcpAgent).toHaveBeenCalledWith({
        backendId: "acp:gemini",
        distributionKind: "npx",
        confirmed: true,
      });
    });
  });
});
