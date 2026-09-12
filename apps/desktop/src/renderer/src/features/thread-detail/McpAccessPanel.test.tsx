import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { McpConnectionStatus } from "@pwragent/shared";
import { McpAccessPanel, ThreadMcpAccessPanel } from "./McpAccessPanel";

function connection(
  overrides: Partial<McpConnectionStatus> & Pick<McpConnectionStatus, "id">,
): McpConnectionStatus {
  return {
    displayName: overrides.id,
    serverUrl: `https://mcp.example.com/${overrides.id}`,
    authMode: "oauth",
    kind: "remote",
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    configured: true,
    state: "ready",
    ...overrides,
  } as McpConnectionStatus;
}

const READY = connection({ id: "datadog", displayName: "Datadog" });

describe("McpAccessPanel", () => {
  it("adds a connection to the thread's selection", async () => {
    const onSelectionChange = vi.fn(async () => undefined);
    render(
      <McpAccessPanel
        backend="codex"
        desktopApi={{
          listMcpConnections: async () => ({ connections: [READY] }),
        }}
        selection={{ connectionIds: [], providerServersEnabled: true }}
        onDismiss={vi.fn()}
        onSelectionChange={onSelectionChange}
      />,
    );

    fireEvent.click(
      await screen.findByRole("switch", { name: "Use Datadog in this thread" }),
    );
    await waitFor(() => {
      expect(onSelectionChange).toHaveBeenCalledWith({
        connectionIds: ["datadog"],
        providerServersEnabled: true,
      });
    });
  });

  it("offers the remedy for a connection that needs authorization", async () => {
    const onOpenSettings = vi.fn();
    render(
      <McpAccessPanel
        backend="codex"
        desktopApi={{
          listMcpConnections: async () => ({
            connections: [
              connection({
                id: "datadog",
                displayName: "Datadog",
                state: "reauthorization_required",
              }),
            ],
          }),
        }}
        selection={{ connectionIds: [], providerServersEnabled: true }}
        onDismiss={vi.fn()}
        onOpenSettings={onOpenSettings}
        onSelectionChange={vi.fn()}
      />,
    );

    // The defect this replaces was a disabled switch: it named a problem and
    // withheld every way to act on it.
    fireEvent.click(await screen.findByRole("button", { name: "Authorize" }));
    expect(onOpenSettings).toHaveBeenCalled();
    expect(screen.queryByRole("switch", { name: /Datadog/ })).toBeNull();
    expect(screen.getByText("Login required")).toBeTruthy();
  });

  it("reports connections that are turned off profile-wide", async () => {
    render(
      <McpAccessPanel
        backend="codex"
        desktopApi={{
          listMcpConnections: async () => ({
            connections: [
              READY,
              connection({
                id: "sentry",
                displayName: "Sentry",
                enabled: false,
              }),
            ],
          }),
        }}
        selection={{ connectionIds: [], providerServersEnabled: true }}
        onDismiss={vi.fn()}
        onSelectionChange={vi.fn()}
      />,
    );

    expect(
      await screen.findByText("Sentry is turned off for every thread."),
    ).toBeTruthy();
    expect(screen.queryByRole("switch", { name: /Sentry/ })).toBeNull();
  });

  it("states when a change reaches a Codex thread", async () => {
    render(
      <McpAccessPanel
        backend="codex"
        desktopApi={{
          listMcpConnections: async () => ({ connections: [READY] }),
        }}
        selection={{ connectionIds: [], providerServersEnabled: true }}
        onDismiss={vi.fn()}
        onSelectionChange={vi.fn()}
      />,
    );

    expect(
      await screen.findByText("Applies to your next message."),
    ).toBeTruthy();
    expect(
      screen.getByRole("switch", {
        name: "Use the agent's own MCP servers in this thread",
      }),
    ).toBeTruthy();
  });

  it("states the later apply point for an ACP thread and hides isolation", async () => {
    render(
      <McpAccessPanel
        backend="acp:claude-code"
        desktopApi={{
          listMcpConnections: async () => ({ connections: [READY] }),
        }}
        selection={{ connectionIds: [], providerServersEnabled: true }}
        onDismiss={vi.fn()}
        onSelectionChange={vi.fn()}
      />,
    );

    expect(
      await screen.findByText(
        "Applies the next time this thread's session loads.",
      ),
    ).toBeTruthy();
    // Only Codex can suppress the agent's own servers, so offering the
    // control elsewhere would promise something the backend cannot honor.
    expect(
      screen.queryByRole("switch", {
        name: "Use the agent's own MCP servers in this thread",
      }),
    ).toBeNull();
  });
});

describe("ThreadMcpAccessPanel", () => {
  it("saves through the thread IPC and keeps the main process's answer", async () => {
    const setThreadMcpConnections = vi.fn(async () => ({
      connectionIds: ["datadog"],
      // The main process refused isolation, so the panel must not keep
      // showing the value the operator asked for.
      providerServersEnabled: true,
    }));
    render(
      <ThreadMcpAccessPanel
        backend="codex"
        desktopApi={{
          listMcpConnections: async () => ({ connections: [READY] }),
          readThreadMcpConnections: async () => ({
            connectionIds: ["datadog"],
            providerServersEnabled: true,
          }),
          setThreadMcpConnections,
        }}
        threadId="thread-1"
        onDismiss={vi.fn()}
      />,
    );

    const isolate = await screen.findByRole("switch", {
      name: "Use the agent's own MCP servers in this thread",
    });
    expect(isolate.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(isolate);
    await waitFor(() => {
      expect(setThreadMcpConnections).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        connectionIds: ["datadog"],
        providerServersEnabled: false,
      });
    });
    await waitFor(() => {
      expect(
        screen
          .getByRole("switch", {
            name: "Use the agent's own MCP servers in this thread",
          })
          .getAttribute("aria-checked"),
      ).toBe("true");
    });
  });

  it("surfaces a failure to read the thread's selection", async () => {
    render(
      <ThreadMcpAccessPanel
        backend="codex"
        desktopApi={{
          listMcpConnections: async () => ({ connections: [READY] }),
          readThreadMcpConnections: async () => {
            throw new Error("That thread is no longer available.");
          },
        }}
        threadId="thread-1"
        onDismiss={vi.fn()}
      />,
    );

    expect(
      await screen.findByText("That thread is no longer available."),
    ).toBeTruthy();
  });

  it("lets a parked connection be dropped from the thread", async () => {
    const onSelectionChange = vi.fn(async () => undefined);
    render(
      <McpAccessPanel
        backend="codex"
        desktopApi={{
          listMcpConnections: async () => ({
            connections: [
              connection({
                id: "acme",
                displayName: "Acme",
                enabled: false,
              }),
            ],
          }),
        }}
        selection={{ connectionIds: ["acme"], providerServersEnabled: true }}
        onDismiss={vi.fn()}
        onSelectionChange={onSelectionChange}
      />,
    );

    fireEvent.click(
      await screen.findByRole("switch", { name: "Use Acme in this thread" }),
    );
    await waitFor(() => {
      expect(onSelectionChange).toHaveBeenCalledWith({
        connectionIds: [],
        providerServersEnabled: true,
      });
    });
  });

  it("lets a removed connection be dropped from the thread", async () => {
    const onSelectionChange = vi.fn(async () => undefined);
    render(
      <McpAccessPanel
        backend="codex"
        desktopApi={{
          listMcpConnections: async () => ({ connections: [] }),
        }}
        selection={{ connectionIds: ["gone"], providerServersEnabled: true }}
        onDismiss={vi.fn()}
        onSelectionChange={onSelectionChange}
      />,
    );

    fireEvent.click(
      await screen.findByRole("switch", { name: "Use gone in this thread" }),
    );
    await waitFor(() => {
      expect(onSelectionChange).toHaveBeenCalledWith({
        connectionIds: [],
        providerServersEnabled: true,
      });
    });
  });

  it("does not drop a pending change when a second control is used", async () => {
    let release: (() => void) | undefined;
    const onSelectionChange = vi.fn(
      async () =>
        await new Promise<undefined>((resolve) => {
          release = () => resolve(undefined);
        }),
    );
    render(
      <McpAccessPanel
        backend="codex"
        desktopApi={{
          listMcpConnections: async () => ({
            connections: [
              READY,
              connection({ id: "sentry", displayName: "Sentry" }),
            ],
          }),
        }}
        selection={{ connectionIds: [], providerServersEnabled: true }}
        onDismiss={vi.fn()}
        onSelectionChange={onSelectionChange}
      />,
    );

    fireEvent.click(
      await screen.findByRole("switch", { name: "Use Datadog in this thread" }),
    );
    await waitFor(() => expect(onSelectionChange).toHaveBeenCalledTimes(1));
    // The first write has not resolved, so the caller's selection is still
    // empty. A second toggle now would compose against it and revert Datadog.
    fireEvent.click(
      screen.getByRole("switch", { name: "Use Sentry in this thread" }),
    );
    fireEvent.click(
      screen.getByRole("switch", {
        name: "Use the agent's own MCP servers in this thread",
      }),
    );
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    release?.();
  });

  it("offers the isolation control even with no managed connections", async () => {
    render(
      <McpAccessPanel
        backend="codex"
        desktopApi={{
          listMcpConnections: async () => ({ connections: [] }),
        }}
        selection={{ connectionIds: [], providerServersEnabled: false }}
        onDismiss={vi.fn()}
        onSelectionChange={vi.fn(async () => undefined)}
      />,
    );

    expect(
      await screen.findByRole("switch", {
        name: "Use the agent's own MCP servers in this thread",
      }),
    ).toBeTruthy();
  });
});

describe("thread verification", () => {
  it("shows a managed connection by the operator's own name, not its hashed alias", async () => {
    // The only surface that could confirm a thread loaded the tools was the
    // agent's own inventory, which names a managed connection
    // `pwragent_<name>_<32 hex>` — a string that appears nowhere in Settings.
    render(
      <ThreadMcpAccessPanel
        backend="codex"
        desktopApi={{
          listMcpConnections: async () => ({ connections: [READY] }),
          readThreadMcpConnections: async () => ({
            connectionIds: ["datadog"],
            providerServersEnabled: true,
          }),
          describeThreadMcpConnections: async () => ({
            backend: "codex" as const,
            threadId: "thread-1",
            connections: [
              {
                connectionId: "datadog",
                displayName: "Datadog",
                serverNameInAgent:
                  "pwragent_datadog_a3f9c2e1b8d47f60a1c2e3d4b5a6f708",
                state: "ready" as const,
                configured: true,
                enabled: true,
                toolCount: 18,
              },
            ],
            providerServersEnabled: true,
            appliesAt: "next_turn" as const,
            handedOverAt: Date.UTC(2026, 0, 1, 14, 2),
            agentInventoryAvailable: true,
          }),
        }}
        threadId="thread-1"
        onDismiss={vi.fn()}
      />,
    );

    expect(await screen.findByText("In this thread")).toBeTruthy();
    expect(screen.getByText("18 tools")).toBeTruthy();
    expect(screen.queryByText(/pwragent_datadog_/)).toBeNull();
  });

  it("states what was handed over for a backend that cannot be asked", async () => {
    // An ACP agent resolves its own servers and takes no inventory question,
    // so silence was the shipped answer on exactly the backends this gateway
    // exists to serve.
    render(
      <ThreadMcpAccessPanel
        backend="acp:grok"
        desktopApi={{
          listMcpConnections: async () => ({ connections: [READY] }),
          readThreadMcpConnections: async () => ({
            connectionIds: ["datadog"],
            providerServersEnabled: true,
          }),
          describeThreadMcpConnections: async () => ({
            backend: "acp:grok" as const,
            threadId: "thread-1",
            connections: [
              {
                connectionId: "datadog",
                displayName: "Datadog",
                serverNameInAgent: "pwragent_datadog_abc",
                state: "ready" as const,
                configured: true,
                enabled: true,
              },
            ],
            providerServersEnabled: true,
            appliesAt: "next_session_load" as const,
            handedOverAt: Date.UTC(2026, 0, 1, 14, 2),
            agentInventoryAvailable: false,
          }),
        }}
        threadId="thread-1"
        onDismiss={vi.fn()}
      />,
    );

    expect(await screen.findByText("Handed to this session")).toBeTruthy();
    expect(screen.getByText("passed to the agent")).toBeTruthy();
    expect(screen.getByText(/cannot be asked what it loaded/)).toBeTruthy();
  });

  it("stays silent rather than guessing when the read fails", async () => {
    render(
      <ThreadMcpAccessPanel
        backend="codex"
        desktopApi={{
          listMcpConnections: async () => ({ connections: [READY] }),
          readThreadMcpConnections: async () => ({
            connectionIds: ["datadog"],
            providerServersEnabled: true,
          }),
          describeThreadMcpConnections: async () => {
            throw new Error("federated window");
          },
        }}
        threadId="thread-1"
        onDismiss={vi.fn()}
      />,
    );

    await screen.findByText("Datadog");
    expect(screen.queryByText("In this thread")).toBeNull();
  });
});
