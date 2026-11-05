import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, McpConnectionStatus } from "@pwragent/shared";
import { McpAccessPanel, ThreadMcpAccessPanel, useThreadMcpConnectionCount } from "./McpAccessPanel";

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
  it.each(["codex", "claude"] as const)("adds a connection to a %s thread selection", async (backend) => {
    const onSelectionChange = vi.fn(async () => undefined);
    render(
      <McpAccessPanel
        backend={backend}
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

  it.each([{ connectionIds: [] }, { connectionIds: ["pwrgit"] }])(
    "lets a signed-in unreachable connection be selected without authorizing again (%s)",
    async ({ connectionIds }) => {
      const onSelectionChange = vi.fn(async () => undefined);
      render(
        <McpAccessPanel
          backend="codex"
          desktopApi={{
            listMcpConnections: async () => ({
              connections: [connection({
                id: "pwrgit",
                displayName: "PwrGit",
                state: "temporarily_unavailable",
                detail: "PwrGit is not running.",
              })],
            }),
          }}
          selection={{ connectionIds, providerServersEnabled: true }}
          onDismiss={vi.fn()}
          onOpenSettings={vi.fn()}
          onSelectionChange={onSelectionChange}
        />,
      );

      const toggle = await screen.findByRole("switch", { name: "Use PwrGit in this thread" });
      expect(toggle.getAttribute("aria-checked")).toBe(String(connectionIds.length > 0));
      expect(screen.queryByRole("button", { name: "Authorize" })).toBeNull();
      expect(screen.getByText("PwrGit is not running.")).toBeTruthy();
      fireEvent.click(toggle);
      await waitFor(() => expect(onSelectionChange).toHaveBeenCalledWith({
        connectionIds: connectionIds.length > 0 ? [] : ["pwrgit"],
        providerServersEnabled: true,
      }));
    },
  );

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
  it("reads, verifies, and toggles the remote owner's connections", async () => {
    const federationTarget = { scope: "remote" as const, instanceId: "owner" };
    const list = vi.fn(async () => ({ connections: [READY] }));
    const read = vi.fn(async () => ({ connectionIds: [], providerServersEnabled: true }));
    const write = vi.fn(async () => ({ connectionIds: ["datadog"], providerServersEnabled: true }));
    const describe = vi.fn(async () => ({ backend: "codex" as const, threadId: "thread-1", connections: [], providerServersEnabled: true, appliesAt: "next_turn" as const, agentInventoryAvailable: false }));
    render(<ThreadMcpAccessPanel
      backend="codex"
      threadId="thread-1"
      federationTarget={federationTarget}
      desktopApi={{ listMcpConnections: list, readThreadMcpConnections: read, setThreadMcpConnections: write, describeThreadMcpConnections: describe }}
      onDismiss={vi.fn()}
    />);
    fireEvent.click(await screen.findByRole("switch", { name: "Use Datadog in this thread" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith({ backend: "codex", threadId: "thread-1", federationTarget, connectionIds: ["datadog"], providerServersEnabled: true }));
    expect(list).toHaveBeenCalledWith({ federationTarget });
    expect(read).toHaveBeenCalledWith({ backend: "codex", threadId: "thread-1", federationTarget });
    expect(describe).toHaveBeenCalledWith({ backend: "codex", threadId: "thread-1", federationTarget });
    expect(screen.queryByRole("button", { name: "Manage connections" })).toBeNull();
    await waitFor(() => expect(screen.getByRole("switch", { name: "Use Datadog in this thread" }).getAttribute("aria-checked")).toBe("true"));
  });

  it("disables changes when the owner's selection cannot be read", async () => {
    const write = vi.fn();
    render(<ThreadMcpAccessPanel
      backend="codex"
      threadId="thread-1"
      federationTarget={{ scope: "remote", instanceId: "owner" }}
      desktopApi={{
        listMcpConnections: async () => ({ connections: [READY] }),
        readThreadMcpConnections: async () => { throw new Error("Owner disconnected"); },
        setThreadMcpConnections: write,
      }}
      onDismiss={vi.fn()}
    />);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Owner disconnected");
    const toggle = await screen.findByRole("switch", { name: "Use Datadog in this thread" });
    expect(toggle).toHaveProperty("disabled", true);
    fireEvent.click(toggle);
    expect(write).not.toHaveBeenCalled();
  });

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
    await act(async () => {
      release?.();
    });
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


describe("remote MCP connection count", () => {
  const owner = { scope: "remote" as const, instanceId: "owner" };
  const threeConnections = {
    connectionIds: ["rovo", "datadog", "sandboxer"],
    providerServersEnabled: true,
  };
  function pendingRead() {
    let resolve!: (value: typeof threeConnections) => void;
    let reject!: (cause: Error) => void;
    const promise = new Promise<typeof threeConnections>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("keeps the badge and subscription stable when remote snapshots replace the target object", async () => {
    const read = vi.fn(async () => threeConnections);
    const unsubscribe = vi.fn();
    const onAgentEvent = vi.fn(() => unsubscribe);
    const desktopApi = { readThreadMcpConnections: read, onAgentEvent };
    const counts: (number | undefined)[] = [];
    const { result, rerender } = renderHook(({ federationTarget }) => {
      const count = useThreadMcpConnectionCount({
        backend: "codex", threadId: "thread-1", federationTarget, desktopApi,
      });
      counts.push(count);
      return count;
    }, { initialProps: { federationTarget: owner } });
    await waitFor(() => expect(result.current).toBe(3));
    counts.length = 0;

    for (let snapshot = 0; snapshot < 5; snapshot += 1) {
      rerender({ federationTarget: { ...owner } });
    }

    expect(counts).toEqual([3, 3, 3, 3, 3]);
    expect(read).toHaveBeenCalledOnce();
    expect(onAgentEvent).toHaveBeenCalledOnce();
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it("retains the saved count through pending and failed refreshes, then accepts a confirmed zero", async () => {
    let receive: ((event: AgentEvent) => void) | undefined;
    const read = vi.fn(async () => threeConnections);
    const desktopApi = {
      readThreadMcpConnections: read,
      onAgentEvent: (listener: (event: AgentEvent) => void) => {
        receive = listener;
        return () => undefined;
      },
    };
    const counts: (number | undefined)[] = [];
    const { result, rerender } = renderHook(({ token }) => {
      const count = useThreadMcpConnectionCount({
        backend: "codex", threadId: "thread-1", federationTarget: owner, desktopApi, token,
      });
      counts.push(count);
      return count;
    }, { initialProps: { token: 0 } });
    await waitFor(() => expect(result.current).toBe(3));
    counts.length = 0;

    const failed = pendingRead();
    read.mockReturnValueOnce(failed.promise);
    rerender({ token: 1 });
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(3);
    await act(async () => failed.reject(new Error("Owner disconnected")));
    expect(result.current).toBe(3);

    const refreshed = pendingRead();
    read.mockReturnValueOnce(refreshed.promise);
    act(() => receive?.({
      backend: "codex", federationTarget: owner,
      notification: { method: "thread/mcpConnections/updated", params: { threadId: "thread-1" } },
    } as AgentEvent));
    expect(read).toHaveBeenCalledTimes(3);
    expect(result.current).toBe(3);
    await act(async () => refreshed.resolve({ connectionIds: [], providerServersEnabled: true }));
    expect(result.current).toBe(0);
    expect(counts).not.toContain(undefined);
  });

  it.each([
    { threadId: "thread-2" },
    { backend: "claude" as const },
    { federationTarget: { scope: "remote" as const, instanceId: "other-owner" } },
    { federationTarget: undefined },
    { threadId: undefined },
  ])("hides the previous scope's count immediately on switching to %j", async (next) => {
    const read = vi.fn(async () => threeConnections);
    const desktopApi = { readThreadMcpConnections: read };
    type Params = Parameters<typeof useThreadMcpConnectionCount>[0];
    const initialProps: Params = {
      backend: "codex", threadId: "thread-1", federationTarget: owner, desktopApi,
    };
    const counts: (number | undefined)[] = [];
    const { result, rerender } = renderHook((params: Params) => {
      const count = useThreadMcpConnectionCount(params);
      counts.push(count);
      return count;
    }, { initialProps });
    await waitFor(() => expect(result.current).toBe(3));
    counts.length = 0;
    const switched = pendingRead();
    read.mockReturnValueOnce(switched.promise);

    rerender({ ...initialProps, ...next });
    expect(result.current).toBeUndefined();
    expect(counts.every((count) => count === undefined)).toBe(true);
    if (read.mock.calls.length > 1) {
      await act(async () => switched.reject(new Error("New scope unavailable")));
    }
    expect(result.current).toBeUndefined();
  });

  it("ignores a late refresh from the previous owner", async () => {
    const read = vi.fn(async () => threeConnections);
    const desktopApi = { readThreadMcpConnections: read };
    const { result, rerender } = renderHook(({ federationTarget, token }) => useThreadMcpConnectionCount({
      backend: "codex", threadId: "thread-1", federationTarget, desktopApi, token,
    }), { initialProps: { federationTarget: owner, token: 0 } });
    await waitFor(() => expect(result.current).toBe(3));
    const previousOwner = pendingRead();
    read.mockReturnValueOnce(previousOwner.promise);
    rerender({ federationTarget: owner, token: 1 });
    read.mockResolvedValueOnce({ connectionIds: ["other"], providerServersEnabled: true });
    rerender({ federationTarget: { scope: "remote", instanceId: "other-owner" }, token: 1 });
    await waitFor(() => expect(result.current).toBe(1));

    await act(async () => previousOwner.resolve(threeConnections));
    expect(result.current).toBe(1);
  });

  it("refreshes only for the matching owner, backend, and thread", async () => {
    const federationTarget = { scope: "remote" as const, instanceId: "owner" };
    let receive: ((event: AgentEvent) => void) | undefined;
    const read = vi.fn(async () => ({ connectionIds: ["rovo"], providerServersEnabled: true }));
    const desktopApi = {
      readThreadMcpConnections: read,
      onAgentEvent: (listener: (event: AgentEvent) => void) => { receive = listener; return () => undefined; },
    };
    const { result } = renderHook(() => useThreadMcpConnectionCount({ backend: "codex", threadId: "thread-1", federationTarget, desktopApi }));
    await waitFor(() => expect(result.current).toBe(1));
    expect(read).toHaveBeenCalledWith({ backend: "codex", threadId: "thread-1", federationTarget });
    const event = { backend: "codex", notification: { method: "thread/mcpConnections/updated", params: { threadId: "thread-1" } } } as AgentEvent;
    act(() => {
      receive?.(event);
      receive?.({ ...event, federationTarget: { scope: "remote", instanceId: "other-owner" } });
      receive?.({ ...event, backend: "claude", federationTarget });
    });
    expect(read).toHaveBeenCalledOnce();
    read.mockResolvedValue({ connectionIds: ["rovo", "datadog"], providerServersEnabled: true });
    act(() => receive?.({ ...event, federationTarget }));
    await waitFor(() => expect(result.current).toBe(2));
    expect(read).toHaveBeenCalledTimes(2);
  });
});
