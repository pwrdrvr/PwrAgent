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
  it("renders allowlisted ACP agents with provenance before install", async () => {
    const desktopApi: DesktopApi = {
      listAcpAgents: vi.fn(async () => ({
        fetchedAt: 1000,
        entries: [
          {
            backendId: "acp:codex-acp",
            registryId: "codex-acp",
            name: "Codex ACP",
            description: "Codex over ACP",
            version: "0.14.0",
            license: "Apache-2.0",
            authors: ["Zed"],
            repositoryUrl: "https://github.com/zed-industries/codex-acp",
            distributionKind: "npx",
            distributionSource: "@zed-industries/codex-acp@0.14.0",
            installable: true,
            installed: false,
            installStatus: "not-installed",
            authStatus: "not-required",
            verificationStatus: "not-applicable",
            allowlistRuleId: "codex-rule",
          } satisfies AcpAgentSettingsEntry,
        ],
      })),
    };

    render(<AcpAgentsSettings desktopApi={desktopApi} />);

    expect(await screen.findByText("Codex ACP")).toBeInTheDocument();
    expect(screen.getByText("Apache-2.0")).toBeInTheDocument();
    expect(screen.getByText(/@zed-industries\/codex-acp/)).toBeInTheDocument();
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
