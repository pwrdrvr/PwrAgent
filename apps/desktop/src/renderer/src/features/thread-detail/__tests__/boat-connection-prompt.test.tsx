import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  BOAT_MCP_CONNECTION_ID,
  DEFAULT_BOAT_SANDBOX_POLICY,
  SANDBOXER_MCP_CONNECTION_ID,
  type McpConnectionStatus,
} from "@pwragent/shared/contracts/mcp-connections";
import type { DesktopApi } from "../../../lib/desktop-api";
import { BoatPolicyControls, BoatSetupDetail } from "../../settings/BoatConnectionSetup";
import { BoatConnectionPrompt, boatConnectionIds } from "../BoatConnectionPrompt";

// Contrived: shaped like a Boat key, issued by nobody.
const KEY = "boat_live_DADAMAMA0123456789";

function boat(patch: Partial<McpConnectionStatus> = {}): McpConnectionStatus {
  return {
    id: BOAT_MCP_CONNECTION_ID,
    displayName: "Boat",
    kind: "boat",
    authMode: "api_key",
    serverUrl: "boat:compute",
    enabled: true,
    selectForNewThreads: false,
    toolApproval: "approve",
    configured: true,
    state: "ready",
    boatPolicy: DEFAULT_BOAT_SANDBOX_POLICY,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

function listing(...connections: McpConnectionStatus[]): DesktopApi {
  return {
    listMcpConnections: vi.fn(async () => ({ connections })),
    onMcpConnectionsChanged: () => () => undefined,
  } as unknown as DesktopApi;
}

function renderTile(desktopApi: DesktopApi, overrides: {
  remote?: boolean;
  onEnabledChange?: (enabled: boolean) => Promise<void>;
  onOpenSettings?: () => void;
} = {}) {
  return render(
    <BoatConnectionPrompt
      backend="claude"
      desktopApi={desktopApi}
      enabled={false}
      remote={overrides.remote ?? false}
      onEnabledChange={overrides.onEnabledChange ?? (async () => undefined)}
      onOpenSettings={overrides.onOpenSettings}
    />,
  );
}

describe("BoatConnectionPrompt", () => {
  it("advertises Boat until a key is stored, and sends setup to Settings", async () => {
    const onOpenSettings = vi.fn();
    renderTile(listing(boat({ configured: false, enabled: false, state: "disconnected" })), { onOpenSettings });
    fireEvent.click(await screen.findByRole("button", { name: "Set up Boat in Settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(screen.getByText("Cloud Linux machines for your agent · paid service")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("offers the thread switch once connected and offered", async () => {
    const onEnabledChange = vi.fn(async () => undefined);
    renderTile(listing(boat()), { onEnabledChange });
    fireEvent.click(await screen.findByRole("switch", { name: "Use Boat in this thread" }));
    await waitFor(() => expect(onEnabledChange).toHaveBeenCalledWith(true));
    expect(screen.getByText("Bills per second while a sandbox runs")).toBeInTheDocument();
  });

  it("says a rejected key needs reconnecting instead of offering the switch", async () => {
    renderTile(listing(boat({ state: "reauthorization_required" })), { onOpenSettings: () => undefined });
    expect(await screen.findByText("Boat rejected the stored key · reconnect in Settings")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("shows nothing for a remote thread or a main without Boat", async () => {
    const remote = renderTile(listing(boat()), { remote: true });
    expect(remote.container).toBeEmptyDOMElement();
    remote.unmount();
    const api = listing();
    const missing = renderTile(api);
    await waitFor(() => expect(api.listMcpConnections).toHaveBeenCalled());
    await waitFor(() => expect(missing.container).toBeEmptyDOMElement());
  });

  it("composes onto the thread's other connections", () => {
    expect(boatConnectionIds([SANDBOXER_MCP_CONNECTION_ID], true))
      .toEqual([SANDBOXER_MCP_CONNECTION_ID, BOAT_MCP_CONNECTION_ID]);
    expect(boatConnectionIds([SANDBOXER_MCP_CONNECTION_ID, BOAT_MCP_CONNECTION_ID], false))
      .toEqual([SANDBOXER_MCP_CONNECTION_ID]);
  });
});

describe("BoatSetupDetail", () => {
  function renderDetail(connectBoat: DesktopApi["connectBoat"], connection = boat({ configured: false, state: "disconnected" })) {
    const onChanged = vi.fn();
    const onNotice = vi.fn();
    const view = render(
      <BoatSetupDetail
        connection={connection}
        desktopApi={{ connectBoat } as unknown as DesktopApi}
        detail="Paste a Boat API key to connect."
        disabled={false}
        onChanged={onChanged}
        onNotice={onNotice}
      />,
    );
    return { ...view, onChanged, onNotice };
  }

  it("sends a pasted key to main once and keeps none of it on screen", async () => {
    const connectBoat = vi.fn(async () => ({ connectionId: BOAT_MCP_CONNECTION_ID, connection: boat() }));
    const { container, onChanged, onNotice } = renderDetail(connectBoat);
    const input = screen.getByLabelText("Boat API key");
    expect(input).toHaveAttribute("type", "password");
    fireEvent.change(input, { target: { value: `  ${KEY}  ` } });
    fireEvent.click(screen.getByRole("button", { name: "Connect Boat" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(connectBoat).toHaveBeenCalledExactlyOnceWith({ apiKey: KEY });
    expect(input).toHaveValue("");
    expect(container.innerHTML).not.toContain(KEY);
    expect(JSON.stringify(onNotice.mock.calls)).not.toContain(KEY);
  });

  it("refuses text that is not a Boat key without sending it anywhere", () => {
    const connectBoat = vi.fn();
    renderDetail(connectBoat);
    fireEvent.change(screen.getByLabelText("Boat API key"), { target: { value: "ghp_someOtherToken0123456789" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect Boat" }));
    expect(connectBoat).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("That is not a Boat API key");
  });

  it("shows why Boat refused a key and keeps the field for another try", async () => {
    const connectBoat = vi.fn(async () => {
      throw new Error("Boat rejected that API key. Check that it was copied whole and has not expired.");
    });
    renderDetail(connectBoat);
    fireEvent.change(screen.getByLabelText("Boat API key"), { target: { value: KEY } });
    fireEvent.keyDown(screen.getByLabelText("Boat API key"), { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Boat rejected that API key");
    expect(screen.getByRole("button", { name: "Connect Boat" })).toBeEnabled();
  });

  it("shows the account, not a key field, once connected", () => {
    renderDetail(vi.fn(), boat({
      boatAccount: { plan: "pro", activeSandboxes: 1, maxActiveSandboxes: 5, canStart: true },
    }));
    expect(screen.getByText("pro plan · 1 of 5 sandboxes running")).toBeInTheDocument();
    expect(screen.queryByLabelText("Boat API key")).not.toBeInTheDocument();
  });
});

describe("BoatPolicyControls", () => {
  it("writes each limit at once, with the rest of the policy unchanged", async () => {
    const setBoatSandboxPolicy = vi.fn(async () => ({ connectionId: BOAT_MCP_CONNECTION_ID, connection: boat() }));
    const setBoatCleanupOnPrClose = vi.fn(async () => ({ connectionId: BOAT_MCP_CONNECTION_ID, connection: boat() }));
    const onChanged = vi.fn();
    render(
      <BoatPolicyControls
        connection={boat()}
        desktopApi={{ setBoatSandboxPolicy, setBoatCleanupOnPrClose } as unknown as DesktopApi}
        disabled={false}
        onChanged={onChanged}
        onNotice={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Keep my credentials out of Boat sandboxes" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(setBoatSandboxPolicy).toHaveBeenCalledWith({
      policy: { ...DEFAULT_BOAT_SANDBOX_POLICY, keepCredentialsOut: false },
    });
    fireEvent.click(screen.getByRole("switch", { name: "Clean up Boat sandboxes when PRs close" }));
    await waitFor(() => expect(setBoatCleanupOnPrClose).toHaveBeenCalledWith({ enabled: false }));
    expect(screen.getByText(/Agents cannot make a sandbox port public/)).toBeInTheDocument();
  });
});
