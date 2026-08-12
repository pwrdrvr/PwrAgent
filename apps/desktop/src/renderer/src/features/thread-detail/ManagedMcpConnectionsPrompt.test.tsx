import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ManagedMcpConnectionsPrompt } from "./ManagedMcpConnectionsPrompt";

describe("ManagedMcpConnectionsPrompt", () => {
  it("offers configured gateway connections without exposing credentials", async () => {
    const onEnabledChange = vi.fn(async () => undefined);
    render(
      <ManagedMcpConnectionsPrompt
        backend="codex"
        desktopApi={{
          listMcpConnections: async () => ({
            connections: [
              {
                id: "pwrsnap",
                displayName: "PwrSnap",
                serverUrl: "http://127.0.0.1:51729/mcp",
                authMode: "oauth",
                kind: "pwrsnap",
                enabled: true,
                createdAt: 0,
                updatedAt: 0,
                configured: true,
                state: "ready",
              },
              {
                id: "datadog",
                displayName: "Datadog",
                serverUrl: "https://mcp.datadoghq.com/mcp",
                authMode: "oauth",
                kind: "remote",
                enabled: true,
                createdAt: 1,
                updatedAt: 1,
                configured: true,
                state: "ready",
              },
            ],
          }),
        }}
        enabledConnectionIds={[]}
        remote={false}
        onEnabledChange={onEnabledChange}
      />,
    );

    const toggle = await screen.findByRole("switch", {
      name: "Use Datadog in this thread",
    });
    expect(screen.queryByRole("switch", { name: /PwrSnap/ })).toBeNull();
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(onEnabledChange).toHaveBeenCalledWith("datadog", true);
    });
  });

  it("does not project local managed connections into a remote launchpad", () => {
    const listMcpConnections = vi.fn();
    const { container } = render(
      <ManagedMcpConnectionsPrompt
        backend="codex"
        desktopApi={{ listMcpConnections }}
        enabledConnectionIds={[]}
        remote
        onEnabledChange={vi.fn()}
      />,
    );

    expect(container.childElementCount).toBe(0);
    expect(listMcpConnections).not.toHaveBeenCalled();
  });
});
