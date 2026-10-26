import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFederatedThreadRef, type McpConnectionStatus, type NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { useIntegratedTerminals } from "../../../lib/useIntegratedTerminals";
import {
  ThreadView as ThreadViewWithTerminals,
  type ThreadViewProps,
} from "../ThreadView";

function ThreadView(props: Omit<ThreadViewProps, "terminals">): ReactElement {
  const terminals = useIntegratedTerminals(props.desktopApi);
  return <ThreadViewWithTerminals {...props} terminals={terminals} />;
}

afterEach(() => {
  cleanup();
});

const baseProps: Omit<ThreadViewProps, "terminals"> = {
  addOptimisticUserMessage: () => "optimistic-1",
  backends: [],
  clearPendingRequest: () => undefined,
  composerDisabled: false,
  loading: false,
  loadingMore: false,
  messageCount: 0,
  skills: [],
  transcriptEntries: [],
  onLoadOlder: async () => undefined,
  removeOptimisticMessage: () => undefined,
};

const target = { scope: "remote" as const, instanceId: "owner" };
const remoteThread: NavigationThreadSummary = {
  id: "thread-1", source: "codex", title: "Example", titleSource: "explicit",
  linkedDirectories: [], inbox: { inInbox: false },
  federation: {
    ref: buildFederatedThreadRef({ instanceId: target.instanceId, backend: "codex", threadId: "thread-1" }),
    instanceLabel: "Studio", peerStatus: "connected",
    capabilities: ["thread_detail", "turn_control", "thread_mcp_connections"],
  },
};

describe("ThreadView remote MCP access", () => {
  it.each([false, true])("opens the owner's connections from a remote thread (remote window: %s)", async (remoteWindow) => {
    const sandboxer: McpConnectionStatus = {
      id: "builtin:sandboxer", displayName: "Sandboxer", kind: "sandboxer",
      authMode: "local_cli", serverUrl: "", enabled: true,
      createdAt: 0, updatedAt: 0, configured: true, state: "ready",
    };
    const read: NonNullable<DesktopApi["readThreadMcpConnections"]> = vi.fn(async (request) => ({
      connectionIds: request.federationTarget?.instanceId === target.instanceId ? [] : [sandboxer.id],
      providerServersEnabled: true,
    }));
    const list: NonNullable<DesktopApi["listMcpConnections"]> = vi.fn(async (request) => ({
      connections: [request?.federationTarget?.instanceId === target.instanceId
        ? { ...sandboxer, configured: false, state: "disconnected" as const, detail: "Sandboxer is not set up on Studio." }
        : sandboxer],
    }));
    const openSettings = vi.fn();
    render(<ThreadView
      {...baseProps}
      selectedThread={remoteThread}
      activeFederationTarget={remoteWindow ? target : undefined}
      desktopApi={{ readThreadMcpConnections: read, listMcpConnections: list }}
      onOpenPluginSettings={openSettings}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Thread options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /MCP access/ }));
    await waitFor(() => expect(screen.getByRole("complementary", { name: "MCP access" })).toBeInTheDocument());
    await waitFor(() => expect(list).toHaveBeenCalledWith({ federationTarget: target }));
    expect(read).toHaveBeenCalledWith({ backend: "codex", threadId: "thread-1", federationTarget: target });
    expect(await screen.findByText("Sandboxer is not set up on Studio.")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Use Sandboxer in this thread" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set up in Settings" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Manage connections" })).not.toBeInTheDocument();
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("keeps gateway controls hidden for an owner without protocol support", () => {
    const read = vi.fn();
    render(<ThreadView
      {...baseProps}
      selectedThread={{ ...remoteThread, federation: { ...remoteThread.federation!, capabilities: ["thread_detail", "turn_control"] } }}
      activeFederationTarget={target}
      desktopApi={{ readThreadMcpConnections: read }}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Thread options" }));
    expect(screen.queryByRole("menuitem", { name: /MCP access/ })).not.toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
  });
});
