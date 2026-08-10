import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../lib/desktop-api";
import { McpInventoryPanel } from "../McpInventoryPanel";

afterEach(() => {
  cleanup();
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
    expect(screen.getByText("OAuth")).toBeInTheDocument();
    expect(listThreadMcpServers).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      detail: "toolsAndAuthOnly",
    });
  });

  it("queues a config reload and explains the next-turn boundary", async () => {
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
    fireEvent.click(reload);

    await waitFor(() => {
      expect(reloadCodexMcpConfig).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
      });
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "applies when the next turn starts",
    );
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
