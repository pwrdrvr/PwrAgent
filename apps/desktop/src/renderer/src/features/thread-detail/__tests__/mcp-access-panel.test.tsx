import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpConnectionStatus } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { McpAccessPanel } from "../McpAccessPanel";

afterEach(() => {
  cleanup();
});

function connection(
  overrides: Partial<McpConnectionStatus> & { id: string },
): McpConnectionStatus {
  return {
    displayName: overrides.id,
    serverUrl: `https://${overrides.id}.example/mcp`,
    authMode: "oauth",
    kind: "remote",
    enabled: true,
    configured: true,
    state: "ready",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function renderPanel(
  connections: McpConnectionStatus[],
  selected: string[],
) {
  const onSelectionChange = vi.fn(async () => undefined);
  const desktopApi = {
    listMcpConnections: vi.fn().mockResolvedValue({ connections }),
  } as unknown as DesktopApi;
  render(
    <McpAccessPanel
      backend="codex"
      desktopApi={desktopApi}
      selection={{ connectionIds: selected, providerServersEnabled: true }}
      onDismiss={() => undefined}
      onOpenSettings={() => undefined}
      onSelectionChange={onSelectionChange}
    />,
  );
  return { onSelectionChange };
}

describe("McpAccessPanel", () => {
  /**
   * A default seeds a new thread's selection; it does not lock it. A seeded
   * connection whose credentials expire before the thread is started used to
   * lose its switch for an Authorize button, which left it selected with no
   * way to drop it from inside the thread.
   */
  it("keeps a switch on a selected connection that stopped working", async () => {
    const { onSelectionChange } = renderPanel(
      [connection({ id: "datadog", state: "reauthorization_required" })],
      ["datadog"],
    );

    const row = within(
      (await screen.findByText("datadog")).closest("li")!,
    );
    const toggle = row.getByRole("switch", { name: "Use datadog in this thread" });
    expect(toggle).toBeChecked();
    expect(
      row.getByText("Login required. Fix it in Settings, or drop it here."),
    ).toBeInTheDocument();

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(onSelectionChange).toHaveBeenCalledWith({
        connectionIds: [],
        providerServersEnabled: true,
      });
    });
  });

  it("still offers only the remedy for a broken connection nobody selected", async () => {
    renderPanel(
      [connection({ id: "datadog", state: "reauthorization_required" })],
      [],
    );

    const row = within(
      (await screen.findByText("datadog")).closest("li")!,
    );
    // Turning on a connection that cannot answer would be a selection that
    // silently drops out of every turn.
    expect(row.queryByRole("switch")).not.toBeInTheDocument();
    expect(row.getByRole("button", { name: "Authorize" })).toBeInTheDocument();
  });

  it("offers a seeded, healthy connection as an ordinary switch", async () => {
    const { onSelectionChange } = renderPanel(
      [connection({ id: "datadog", selectForNewThreads: true })],
      ["datadog"],
    );

    const toggle = await screen.findByRole("switch", {
      name: "Use datadog in this thread",
    });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(onSelectionChange).toHaveBeenCalledWith({
        connectionIds: [],
        providerServersEnabled: true,
      });
    });
  });
});
