import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopSettingsSnapshot } from "@pwragent/shared/contracts/settings";
import type { DesktopApi } from "../../../lib/desktop-api";
import type { DesktopSettingsState } from "../../settings/useDesktopSettings";
import { AgentSetupPane } from "../AgentSetupPane";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
        profiles: { profiles: [] },
      },
    },
  } as unknown as DesktopSettingsSnapshot;
}

function settingsState(codexInstalled: boolean): DesktopSettingsState {
  return {
    snapshot: snapshot(codexInstalled),
    saving: false,
    refresh: vi.fn(async () => undefined),
    applySnapshot: vi.fn(),
    writeConfig: vi.fn(async () => true),
  } as unknown as DesktopSettingsState;
}

function api(params: { codexInstalled: boolean; onWindowFocus?: (listener: () => void) => () => void }) {
  return {
    platform: "darwin",
    refreshCodexDiscovery: vi.fn(async () => ({ snapshot: snapshot(params.codexInstalled) })),
    listAcpAgents: vi.fn(async () => ({ fetchedAt: 1, entries: [] })),
    listBackends: vi.fn(async () => ({ fetchedAt: 1, backends: [] })),
    checkCodexAuthProfileStatus: vi.fn(async () => ({
      profile: "",
      authenticated: true,
      email: "sam@example.com",
    })),
    copyText: vi.fn(async () => undefined),
    ...(params.onWindowFocus ? { onWindowFocus: vi.fn(params.onWindowFocus) } : {}),
  } as unknown as DesktopApi & Record<string, ReturnType<typeof vi.fn>>;
}

describe("Agent setup pane", () => {
  it("names why a set-up agent failed to start instead of calling it ready", async () => {
    render(
      <AgentSetupPane
        settings={settingsState(true)}
        desktopApi={api({ codexInstalled: true })}
        unavailableDetail="Codex: The Codex app server exited during startup."
        onOpenProviderSettings={() => undefined}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "Your agent didn't start." }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Codex: The Codex app server exited during startup.",
    );
    expect(screen.queryByRole("heading", { name: "Your agent is ready." })).toBeNull();
  });

  it("keeps the setup heading, without a failure line, while no agent is set up", async () => {
    render(
      <AgentSetupPane
        settings={settingsState(false)}
        desktopApi={api({ codexInstalled: false })}
        unavailableDetail="OpenAI: No Codex executable was found on this machine."
        onOpenProviderSettings={() => undefined}
      />,
    );
    await screen.findByRole("button", { name: "Install Codex" });
    expect(screen.getByRole("heading", { name: "Set up an agent to start." })).toBeInTheDocument();
    expect(screen.queryByText(/No Codex executable was found/)).toBeNull();
  });

  it("rechecks agents on window focus only after an install or sign-in step opens", async () => {
    let focus: () => void = () => undefined;
    const desktopApi = api({
      codexInstalled: false,
      onWindowFocus: (listener) => {
        focus = listener;
        return () => undefined;
      },
    });
    render(
      <AgentSetupPane
        settings={settingsState(false)}
        desktopApi={desktopApi}
        onOpenProviderSettings={() => undefined}
      />,
    );
    await screen.findByRole("button", { name: "Check again" });
    expect(desktopApi.listAcpAgents).toHaveBeenCalledOnce();
    // Nothing is ready, but nobody started a setup step: no recheck.
    await act(async () => { focus(); });
    expect(desktopApi.listAcpAgents).toHaveBeenCalledOnce();
    const codexRow = screen.getByText("Codex", { selector: ".get-started__agent-name" }).closest("li") as HTMLElement;
    fireEvent.click(within(codexRow).getByRole("button", { name: "Install it yourself instead" }));
    await act(async () => { focus(); });
    await waitFor(() => expect(desktopApi.listAcpAgents).toHaveBeenCalledTimes(2));
  });
});
