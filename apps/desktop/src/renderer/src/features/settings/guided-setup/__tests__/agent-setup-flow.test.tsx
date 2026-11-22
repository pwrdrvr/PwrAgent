import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpAgentSettingsEntry } from "@pwragent/shared/contracts/backend";
import type { DesktopSettingsSnapshot } from "@pwragent/shared/contracts/settings";
import type { DesktopApi } from "../../../../lib/desktop-api";
import type { DesktopSettingsState } from "../../useDesktopSettings";
import { AgentSetupFlow } from "../AgentSetupFlow";

afterEach(cleanup);

// Every ACP agent the settings contract lists, written out by hand. The
// `satisfies` makes an agent added to the contract fail typecheck here, so
// this table, and the guided flow's catalogue, must grow with it.
const ACP_AGENTS = {
  gemini: { cliPath: { value: "", source: "default" }, enabled: true },
  grok: { cliPath: { value: "", source: "default" }, enabled: true },
  kimi: { cliPath: { value: "", source: "default" }, enabled: true },
  qwen: { cliPath: { value: "", source: "default" }, enabled: true },
} satisfies DesktopSettingsSnapshot["acpAgents"];

/** The oracle: what each agent's tab must say, independent of the module. */
const EXPECTED: Record<keyof typeof ACP_AGENTS, { name: string; vendor: string }> = {
  gemini: { name: "Gemini CLI", vendor: "Google" },
  grok: { name: "Grok Build", vendor: "SpaceXAI" },
  kimi: { name: "Kimi Code", vendor: "Moonshot AI" },
  qwen: { name: "Qwen Code", vendor: "Alibaba Cloud" },
};

function snapshot(): DesktopSettingsSnapshot {
  return {
    models: {
      codex: {
        discovery: { candidates: [] },
        profiles: { profiles: [] },
      },
    },
    acpAgents: ACP_AGENTS,
  } as unknown as DesktopSettingsSnapshot;
}

function settings(): DesktopSettingsState {
  return {
    snapshot: snapshot(),
    saving: false,
    writeConfig: vi.fn(async () => true),
    refresh: vi.fn(async () => undefined),
  } as unknown as DesktopSettingsState;
}

function entry(
  registryId: string,
  overrides: Partial<AcpAgentSettingsEntry> = {},
): AcpAgentSettingsEntry {
  return {
    backendId: `acp:${registryId}`,
    registryId,
    name: registryId,
    authors: [],
    distributionKind: "local",
    distributionSource: "local",
    installable: false,
    installed: false,
    installStatus: "not-installed",
    authStatus: "unknown",
    verificationStatus: "unverified",
    ...overrides,
  } as AcpAgentSettingsEntry;
}

function fakeApi() {
  return {
    platform: "darwin",
    listAcpAgents: vi.fn(async (): Promise<{ entries: AcpAgentSettingsEntry[] }> => ({
      entries: [],
    })),
    refreshCodexDiscovery: vi.fn(async () => undefined),
    listBackends: vi.fn(async () => ({ backends: [] })),
    checkCodexAuthProfileStatus: vi.fn(async () => ({ authenticated: false })),
    startCodexAuthProfileLogin: vi.fn(async () => ({ authenticated: false })),
    copyText: vi.fn(async () => undefined),
  };
}

async function renderFlow(
  api: ReturnType<typeof fakeApi>,
  entries: AcpAgentSettingsEntry[] = [],
) {
  // The cached read answers with the catalogue Settings already passed in,
  // as main does in the app.
  api.listAcpAgents.mockImplementation(async () => ({ entries }));
  await act(async () => {
    render(
      <AgentSetupFlow
        settings={settings()}
        desktopApi={api as unknown as DesktopApi}
        initialAcpEntries={entries}
        onClose={() => undefined}
      />,
    );
  });
  return screen.getByRole("dialog", { name: "Set up an agent" });
}

describe("guided agent setup", () => {
  it("has a tab for every ACP agent, with that agent's own install copy and notice", async () => {
    const dialog = await renderFlow(fakeApi());
    const tabs = within(dialog).getByRole("tablist", { name: "Agents" });
    for (const [id, expected] of Object.entries(EXPECTED)) {
      fireEvent.click(within(tabs).getByRole("tab", { name: new RegExp(`^${expected.name}`) }));
      const panel = within(dialog).getByRole("tabpanel");
      expect(panel).toHaveAttribute("aria-labelledby", `guided-agent-tab-${id}`);
      expect(within(panel).getByText(`Install or update ${expected.name} on macOS:`))
        .toBeInTheDocument();
      // Not the catalogue's first entry standing in for a missing one.
      expect(within(panel).queryByText(/@openai\/codex/)).toBeNull();
      expect(
        within(dialog).getByText(
          new RegExp(`not affiliated with, endorsed by, or sponsored by ${expected.vendor}\\.$`),
        ),
      ).toBeInTheDocument();
    }
  });

  it("shows what discovery already recorded for an agent", async () => {
    const dialog = await renderFlow(fakeApi(), [
      entry("qwen", {
        installed: true,
        installStatus: "installed",
        version: "0.9.1",
        activeCommand: "/opt/example/bin/qwen",
      }),
    ]);
    const qwenTab = within(dialog).getByRole("tab", { name: /^Qwen Code/ });
    expect(within(qwenTab).getByLabelText("Installed")).toBeInTheDocument();
    expect(
      within(within(dialog).getByRole("tab", { name: /^Kimi Code/ })).getByLabelText("Not found"),
    ).toBeInTheDocument();
    fireEvent.click(qwenTab);
    const panel = within(dialog).getByRole("tabpanel");
    expect(within(panel).getByText("✓ Found v0.9.1")).toBeInTheDocument();
    expect(within(panel).getByText("/opt/example/bin/qwen")).toBeInTheDocument();
  });

  it("probes no CLI until Refresh is clicked, whichever tabs are opened", async () => {
    const api = fakeApi();
    const dialog = await renderFlow(api);
    for (const tab of within(dialog).getAllByRole("tab")) {
      await act(async () => {
        fireEvent.click(tab);
      });
    }
    // Only the cached catalogue was read: no discovery intent, no refresh.
    expect(api.listAcpAgents.mock.calls).toEqual([[{ refresh: false }]]);
    expect(api.refreshCodexDiscovery).not.toHaveBeenCalled();
    expect(api.listBackends).not.toHaveBeenCalled();
    expect(api.checkCodexAuthProfileStatus).not.toHaveBeenCalled();
    expect(api.startCodexAuthProfileLogin).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Refresh after install" }));
    });
    expect(api.listAcpAgents).toHaveBeenLastCalledWith(
      expect.objectContaining({ discoveryIntent: "setup-user-action", refresh: true }),
    );
    expect(api.refreshCodexDiscovery).toHaveBeenCalledWith({
      discoveryIntent: "setup-user-action",
    });
  });
});
