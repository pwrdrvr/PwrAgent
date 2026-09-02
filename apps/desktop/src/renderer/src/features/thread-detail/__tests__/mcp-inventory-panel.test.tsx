import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../lib/desktop-api";
import { McpInventoryPanel } from "../McpInventoryPanel";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as typeof window & {
    __pwragentFederationTarget?: unknown;
  }).__pwragentFederationTarget;
});

const thread = {
  id: "thread-1",
  title: "MCP inventory",
  titleSource: "explicit" as const,
  source: "codex" as const,
  executionMode: "default" as const,
  linkedDirectories: [],
  inbox: { inInbox: false },
};

describe("McpInventoryPanel", () => {
  it("shows the bounded tools-and-auth inventory", async () => {
    const listThreadMcpServers = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      detail: "toolsAndAuthOnly" as const,
      servers: [
        {
          name: "atlassian-rovo",
          authStatus: "oAuth" as const,
          tools: ["fetch", "search"],
        },
      ],
    }));

    render(
      <McpInventoryPanel
        desktopApi={{ listThreadMcpServers }}
        onDismiss={vi.fn()}
        request={{ detail: "toolsAndAuthOnly", requestId: 1 }}
        thread={thread}
      />,
    );

    expect(screen.getByText("Reading MCP inventory…")).toBeInTheDocument();
    expect(await screen.findByText("atlassian-rovo")).toBeInTheDocument();
    expect(screen.getByText("fetch, search")).toBeInTheDocument();
    // Shared vocabulary (`formatMcpAuthStatus`): the chip names the state the
    // operator is in, not the protocol that produced it.
    expect(screen.getByText("Signed in")).toBeInTheDocument();
    expect(listThreadMcpServers).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      detail: "toolsAndAuthOnly",
    });
  });

  it("shows an unknown authentication status without hiding the inventory", async () => {
    render(
      <McpInventoryPanel
        desktopApi={{
          listThreadMcpServers: async () => ({
            backend: "codex",
            threadId: "thread-1",
            detail: "toolsAndAuthOnly",
            servers: [
              {
                name: "offline-local-server",
                authStatus: "unknown",
                tools: [],
              },
            ],
          }),
        }}
        onDismiss={vi.fn()}
        request={{ detail: "toolsAndAuthOnly", requestId: 1 }}
        thread={thread}
      />,
    );

    expect(await screen.findByText("offline-local-server")).toBeInTheDocument();
    expect(screen.getByText("Sign-in state unknown")).toBeInTheDocument();
  });

  it("holds confirmed reload feedback and explains the next-turn boundary", async () => {
    const reloadCodexMcpConfig = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      queued: true as const,
    }));
    const desktopApi: DesktopApi = {
      listThreadMcpServers: async () => ({
        backend: "codex",
        threadId: "thread-1",
        detail: "full",
        servers: [],
      }),
      reloadCodexMcpConfig,
    };

    render(
      <McpInventoryPanel
        desktopApi={desktopApi}
        onDismiss={vi.fn()}
        request={{ detail: "full", requestId: 1 }}
        thread={thread}
      />,
    );

    const reload = screen.getByRole("button", { name: "Reload Config" });
    fireEvent.mouseEnter(reload);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Re-read installed MCP configuration",
    );
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(reload);
      await Promise.resolve();
    });

    expect(reloadCodexMcpConfig).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
    });
    const confirmed = screen.getByRole("button", { name: "Reload queued" });
    expect(confirmed).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "applies when the next turn starts",
    );

    await act(async () => {
      vi.advanceTimersByTime(4_999);
    });
    expect(screen.getByRole("button", { name: "Reload queued" })).toBeDisabled();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole("button", { name: "Reload Config" })).toBeEnabled();
  });

  it("collapses large server catalogs into expandable previews", async () => {
    const tools = Array.from({ length: 10 }, (_, index) => `tool-${index + 1}`);
    const resources = Array.from({ length: 4 }, (_, index) => ({
      name: `resource-${index + 1}`,
      uri: `plugin://resource-${index + 1}`,
    }));

    render(
      <McpInventoryPanel
        desktopApi={{
          listThreadMcpServers: async () => ({
            backend: "codex",
            threadId: "thread-1",
            detail: "full",
            servers: [
              {
                name: "codex_apps",
                authStatus: "oAuth",
                tools,
                resources,
                resourceTemplates: [],
              },
            ],
          }),
        }}
        onDismiss={vi.fn()}
        request={{ detail: "full", requestId: 1 }}
        thread={thread}
      />,
    );

    const panel = await screen.findByRole("complementary", {
      name: "MCP Tools · 1 server · 10 tools",
    });
    expect(panel).toHaveTextContent("tool-8");
    expect(panel).not.toHaveTextContent("tool-9");
    expect(panel).toHaveTextContent("resource-3");
    expect(panel).not.toHaveTextContent("resource-4");

    fireEvent.click(screen.getByRole("button", { name: "Show 2 more Tools" }));
    expect(panel).toHaveTextContent("tool-10");
    fireEvent.click(screen.getByRole("button", { name: "Show fewer Tools" }));
    expect(panel).not.toHaveTextContent("tool-9");

    fireEvent.click(
      screen.getByRole("button", { name: "Show 1 more Resources" }),
    );
    expect(panel).toHaveTextContent("resource-4");
  });

  it("keeps the federation-window target stable across state updates", async () => {
    (window as typeof window & {
      __pwragentFederationTarget?: {
        scope: "remote";
        instanceId: string;
      };
    }).__pwragentFederationTarget = {
      scope: "remote",
      instanceId: "owner-instance",
    };
    const listThreadMcpServers = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      detail: "toolsAndAuthOnly" as const,
      servers: [],
    }));

    render(
      <McpInventoryPanel
        desktopApi={{ listThreadMcpServers }}
        onDismiss={vi.fn()}
        request={{ detail: "toolsAndAuthOnly", requestId: 1 }}
        thread={thread}
      />,
    );

    expect(await screen.findByText("No MCP servers available.")).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(listThreadMcpServers).toHaveBeenCalledTimes(1);
    expect(listThreadMcpServers).toHaveBeenCalledWith({
      backend: "codex",
      federationTarget: {
        scope: "remote",
        instanceId: "owner-instance",
      },
      threadId: "thread-1",
      detail: "toolsAndAuthOnly",
    });
  });
});
