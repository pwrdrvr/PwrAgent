import "@testing-library/jest-dom/vitest";
import {
  act,
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
import { scopeDesktopApiToFederationTarget } from "../../../lib/federation-desktop-api";
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
  const onOpenSettings = vi.fn();
  const desktopApi = {
    listMcpConnections: vi.fn().mockResolvedValue({ connections }),
  } as unknown as DesktopApi;
  render(
    <McpAccessPanel
      backend="codex"
      desktopApi={desktopApi}
      selection={{ connectionIds: selected, providerServersEnabled: true }}
      onDismiss={() => undefined}
      onOpenSettings={onOpenSettings}
      onSelectionChange={onSelectionChange}
    />,
  );
  return { onOpenSettings, onSelectionChange };
}

describe("McpAccessPanel", () => {
  const owner = { scope: "remote" as const, instanceId: "owner" };
  const localSandboxer = connection({ id: "builtin:sandboxer", displayName: "Sandboxer", kind: "sandboxer" });
  const remoteSandboxer = connection({
    ...localSandboxer, configured: false, state: "disconnected",
    sandboxerCliState: "cli_missing", detail: "Sandboxer CLI is not installed on the owner.",
  });

  it("shows the owner's missing Sandboxer setup when the viewer is signed in", async () => {
    const listMcpConnections: NonNullable<DesktopApi["listMcpConnections"]> = vi.fn(async (request) => ({
      connections: [request?.federationTarget?.instanceId === owner.instanceId ? remoteSandboxer : localSandboxer],
    }));
    render(<McpAccessPanel
      backend="codex"
      desktopApi={scopeDesktopApiToFederationTarget({ listMcpConnections }, owner)}
      selection={{ connectionIds: [], providerServersEnabled: true }}
      onDismiss={vi.fn()}
      onSelectionChange={vi.fn()}
    />);

    expect(await screen.findByText(remoteSandboxer.detail!)).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Use Sandboxer in this thread" })).not.toBeInTheDocument();
    expect(listMcpConnections).toHaveBeenCalledExactlyOnceWith({ federationTarget: owner });
  });

  it("clears the viewer's inventory while the remote owner is being read", async () => {
    let finishRemote!: (value: { connections: McpConnectionStatus[] }) => void;
    const remoteRead = new Promise<{ connections: McpConnectionStatus[] }>((resolve) => { finishRemote = resolve; });
    const listMcpConnections: NonNullable<DesktopApi["listMcpConnections"]> = vi.fn(async (request) =>
      request?.federationTarget ? await remoteRead : { connections: [localSandboxer] });
    const props = {
      backend: "codex" as const, desktopApi: { listMcpConnections },
      selection: { connectionIds: [], providerServersEnabled: true },
      onDismiss: vi.fn(), onSelectionChange: vi.fn(),
    };
    const view = render(<McpAccessPanel {...props} />);
    await screen.findByRole("switch", { name: "Use Sandboxer in this thread" });
    view.rerender(<McpAccessPanel {...props} federationTarget={owner} />);

    expect(screen.queryByRole("switch", { name: "Use Sandboxer in this thread" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Reading connections");
    await act(async () => { finishRemote({ connections: [remoteSandboxer] }); });
    expect(await screen.findByText(remoteSandboxer.detail!)).toBeInTheDocument();
  });

  it.each([false, true])("ignores a late viewer inventory result after switching to the owner (failure: %s)", async (fail) => {
    let finishLocal!: (value: { connections: McpConnectionStatus[] }) => void;
    let failLocal!: (error: Error) => void;
    const localRead = new Promise<{ connections: McpConnectionStatus[] }>((resolve, reject) => {
      finishLocal = resolve;
      failLocal = reject;
    });
    const listMcpConnections: NonNullable<DesktopApi["listMcpConnections"]> = vi.fn(async (request) =>
      request?.federationTarget ? { connections: [remoteSandboxer] } : await localRead);
    const props = {
      backend: "codex" as const, desktopApi: { listMcpConnections },
      selection: { connectionIds: [], providerServersEnabled: true },
      onDismiss: vi.fn(), onSelectionChange: vi.fn(),
    };
    const view = render(<McpAccessPanel {...props} />);
    view.rerender(<McpAccessPanel {...props} federationTarget={owner} />);
    await screen.findByText(remoteSandboxer.detail!);
    await act(async () => {
      if (fail) failLocal(new Error("Viewer connection failed"));
      else finishLocal({ connections: [localSandboxer] });
    });

    expect(screen.getByText(remoteSandboxer.detail!)).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Use Sandboxer in this thread" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  /**
   * A default seeds a new thread's selection; it does not lock it. A seeded
   * connection whose credentials expire before the thread is started used to
   * lose its switch for an Authorize button, which left it selected with no
   * way to drop it from inside the thread.
   */
  it("keeps a switch on a selected connection that stopped working", async () => {
    const { onOpenSettings, onSelectionChange } = renderPanel(
      [connection({ id: "datadog", state: "reauthorization_required" })],
      ["datadog"],
    );

    const row = within(
      (await screen.findByText("datadog")).closest("li")!,
    );
    const toggle = row.getByRole("switch", { name: "Use datadog in this thread" });
    expect(toggle).toBeChecked();
    expect(row.getByText("Login required")).toBeInTheDocument();
    // Dropping it is not the only way out: the sign-in that fixes it is
    // still one click from the thread.
    fireEvent.click(row.getByRole("button", { name: "Authorize" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(onSelectionChange).toHaveBeenCalledWith({
        connectionIds: [],
        providerServersEnabled: true,
      });
    });
  });

  it("offers no sign-in for a selected server that is only briefly away", async () => {
    renderPanel(
      [
        connection({
          id: "datadog",
          state: "temporarily_unavailable",
          detail: "The server did not answer the last request.",
        }),
      ],
      ["datadog"],
    );

    const row = within(
      (await screen.findByText("datadog")).closest("li")!,
    );
    expect(
      row.getByRole("switch", { name: "Use datadog in this thread" }),
    ).toBeChecked();
    // The coordinator's own account of the failure, not a generic one.
    expect(
      row.getByText("The server did not answer the last request."),
    ).toBeInTheDocument();
    expect(row.queryByRole("button", { name: "Authorize" })).not.toBeInTheDocument();
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
