import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PWRGIT_MCP_CONNECTION_ID,
  SANDBOXER_MCP_CONNECTION_ID,
  type McpConnectionStatus,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import {
  SandboxerConnectionPrompt,
  sandboxerConnectionIds,
} from "../SandboxerConnectionPrompt";

function sandboxer(patch: Partial<McpConnectionStatus> = {}): McpConnectionStatus {
  return {
    id: SANDBOXER_MCP_CONNECTION_ID,
    displayName: "Sandboxer",
    kind: "sandboxer",
    authMode: "local_cli",
    serverUrl: "sandboxer:compute",
    enabled: true,
    selectForNewThreads: false,
    toolApproval: "prompt",
    configured: true,
    state: "ready",
    sandboxerCliState: "signed_in",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

function api(...answers: McpConnectionStatus[][]): DesktopApi {
  const listMcpConnections = vi.fn();
  for (const connections of answers) {
    listMcpConnections.mockResolvedValueOnce({ connections });
  }
  listMcpConnections.mockResolvedValue({ connections: answers.at(-1) ?? [] });
  return { listMcpConnections } as unknown as DesktopApi;
}

function renderTile(desktopApi: DesktopApi, overrides: {
  enabled?: boolean;
  remote?: boolean;
  onEnabledChange?: (enabled: boolean) => Promise<void>;
  onOpenSettings?: () => void;
} = {}) {
  return render(
    <SandboxerConnectionPrompt
      backend="claude"
      desktopApi={desktopApi}
      enabled={overrides.enabled ?? false}
      remote={overrides.remote ?? false}
      onEnabledChange={overrides.onEnabledChange ?? (async () => undefined)}
      onOpenSettings={overrides.onOpenSettings}
    />,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("sandboxerConnectionIds", () => {
  it("composes onto the thread's other connections", () => {
    expect(sandboxerConnectionIds([PWRGIT_MCP_CONNECTION_ID], true))
      .toEqual([PWRGIT_MCP_CONNECTION_ID, SANDBOXER_MCP_CONNECTION_ID]);
    expect(sandboxerConnectionIds([PWRGIT_MCP_CONNECTION_ID, SANDBOXER_MCP_CONNECTION_ID], false))
      .toEqual([PWRGIT_MCP_CONNECTION_ID]);
  });
});

describe("SandboxerConnectionPrompt", () => {
  it("advertises Sandboxer and links to its install guide while the CLI is missing", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    renderTile(api([sandboxer({
      configured: false, state: "temporarily_unavailable", sandboxerCliState: "cli_missing", enabled: false,
    })]));
    const tile = await screen.findByRole("complementary", { name: "Sandboxer connection" });
    expect(tile).toHaveTextContent("Cloud Linux machines for your agent · paid service");
    fireEvent.click(await screen.findByRole("button", { name: "Get Sandboxer" }));
    expect(open).toHaveBeenLastCalledWith("https://sandboxer.com/docs/quickstart", "_blank", "noopener,noreferrer");
    fireEvent.click(screen.getByRole("button", { name: "Visit sandboxer.com" }));
    expect(open).toHaveBeenLastCalledWith("https://sandboxer.com/", "_blank", "noopener,noreferrer");
    fireEvent.click(screen.getByRole("button", { name: "About Sandboxer" }));
    expect(screen.getByRole("dialog", { name: "About Sandboxer" })).toHaveTextContent("Third-party service · paid");
    expect(screen.queryByLabelText("Use Sandboxer in this thread")).toBeNull();
  });

  it("sends unfinished setup to Settings, where the setup ladder lives", async () => {
    for (const [patch, line] of [
      [{ configured: false, state: "disconnected", sandboxerCliState: "not_signed_in" }, "Sign in with sbx onboard"],
      [{ configured: false, state: "disconnected", sandboxerCliState: "no_plan" }, "Needs a plan"],
      [{ enabled: false }, "Turned off for every thread"],
    ] as const) {
      const onOpenSettings = vi.fn();
      const view = renderTile(api([sandboxer(patch)]), { onOpenSettings });
      expect(await screen.findByText(new RegExp(line))).toBeInTheDocument();
      expect(screen.queryByLabelText("Use Sandboxer in this thread")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Set up Sandboxer in Settings" }));
      expect(onOpenSettings).toHaveBeenCalledOnce();
      view.unmount();
    }
  });

  it("offers the thread switch once set up, and keeps it through a billing problem", async () => {
    const onEnabledChange = vi.fn(async () => undefined);
    const view = renderTile(api([sandboxer()]), { onEnabledChange });
    const toggle = await screen.findByLabelText("Use Sandboxer in this thread");
    expect(screen.getByText("Bills per second while a sandbox runs")).toBeInTheDocument();
    fireEvent.click(toggle);
    await waitFor(() => expect(onEnabledChange).toHaveBeenCalledWith(true));
    view.unmount();

    // New machines won't start, but running ones still need list and stop.
    renderTile(api([sandboxer({ sandboxerCliState: "billing_issue" })]), { enabled: true });
    expect(await screen.findByText(/Billing issue · new sandboxes won’t start/)).toBeInTheDocument();
    expect(screen.getByLabelText("Use Sandboxer in this thread")).toBeEnabled();
  });

  it("catches up when the window regains focus after setup in a terminal", async () => {
    const desktopApi = api(
      [sandboxer({ configured: false, state: "disconnected", sandboxerCliState: "not_signed_in" })],
      [sandboxer()],
    );
    renderTile(desktopApi, { onOpenSettings: () => undefined });
    expect(await screen.findByRole("button", { name: "Set up Sandboxer in Settings" })).toBeInTheDocument();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(await screen.findByLabelText("Use Sandboxer in this thread")).toBeInTheDocument();
    // Status comes from the connection list, never the session-retiring refresh.
    expect(desktopApi.listMcpConnections).toHaveBeenCalledTimes(2);
  });

  it("shows nothing on a remote thread, or without a Sandboxer connection", async () => {
    const remoteApi = api([sandboxer()]);
    const remote = renderTile(remoteApi, { remote: true });
    expect(remote.container).toBeEmptyDOMElement();
    expect(remoteApi.listMcpConnections).not.toHaveBeenCalled();
    remote.unmount();

    const missing = renderTile(api([]));
    await waitFor(() => expect(missing.container).toBeEmptyDOMElement());
  });
});
