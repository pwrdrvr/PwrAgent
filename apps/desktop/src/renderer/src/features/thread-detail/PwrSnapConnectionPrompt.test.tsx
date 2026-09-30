import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  PWRSNAP_MCP_CONNECTION_ID,
  PWRSNAP_SESSION_REVOKED_DETAIL,
  type ConnectPwrSnapResponse,
  type PwrSnapConnectionStatus,
} from "@pwragent/shared";
import { describe, expect, it, vi } from "vitest";
import { PwrSnapConnectionPrompt } from "./PwrSnapConnectionPrompt";

describe("PwrSnapConnectionPrompt", () => {
  it("renders nothing when a remote owner does not report PwrSnap available", async () => {
    const readPwrSnapConnectionStatus = vi.fn(async () => ({
      connectionId: "pwrsnap" as const,
      displayName: "PwrSnap" as const,
      availability: "running" as const,
      configured: false,
    }));
    render(
      <PwrSnapConnectionPrompt
        backend="codex"
        desktopApi={{ readPwrSnapConnectionStatus }}
        enabled={false}
        remoteOwnerLabel="Studio Mac"
        onEnabledChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(readPwrSnapConnectionStatus).toHaveBeenCalledOnce());
    expect(screen.queryByLabelText(/PwrSnap connection/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /PwrSnap/i })).toBeNull();
  });

  it("offers only per-thread enablement for PwrSnap on an available remote owner", async () => {
    const onEnabledChange = vi.fn(async () => undefined);
    render(
      <PwrSnapConnectionPrompt
        backend="codex"
        desktopApi={{
          readPwrSnapConnectionStatus: async () => ({
            connectionId: "pwrsnap",
            displayName: "PwrSnap",
            availability: "running",
            configured: true,
          }),
        }}
        enabled={false}
        remoteOwnerLabel="Studio Mac"
        onEnabledChange={onEnabledChange}
      />,
    );

    const tile = await screen.findByRole("complementary", {
      name: "Remote PwrSnap connection",
    });
    expect(tile.textContent).toContain("Runs on Studio Mac, where this thread runs");
    // Nothing on a remote tile reaches the viewer's own machine or the web.
    expect(screen.queryByRole("button", { name: /About|pwrsnap\.com/ })).toBeNull();
    expect(screen.queryByText("Connect to PwrSnap")).toBeNull();
    expect(screen.queryByText("Get PwrSnap")).toBeNull();
    expect(screen.queryByText("Open PwrSnap")).toBeNull();

    fireEvent.click(screen.getByRole("switch", {
      name: "Enable PwrSnap on Studio Mac in this thread",
    }));
    await waitFor(() => expect(onEnabledChange).toHaveBeenCalledWith(true));
  });

  it("sends a window with no installer API to the product page", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    try {
      render(
        <PwrSnapConnectionPrompt
          backend="codex"
          desktopApi={{
            readPwrSnapConnectionStatus: async () => ({
              connectionId: "pwrsnap",
              displayName: "PwrSnap",
              availability: "not_installed",
              configured: false,
            }),
          }}
          enabled={false}
          onEnabledChange={vi.fn()}
        />,
      );

      expect(await screen.findByText("Screenshots your agents can use")).toBeTruthy();
      fireEvent.click(await screen.findByRole("button", { name: "Get PwrSnap" }));
      expect(open).toHaveBeenCalledWith(
        "https://pwrsnap.com",
        "_blank",
        "noopener,noreferrer",
      );
    } finally {
      open.mockRestore();
    }
  });

  it("connects a running install and then offers a per-thread switch", async () => {
    const connectPwrSnap = vi.fn(async () => ({
      outcome: "connected" as const,
      status: {
        connectionId: "pwrsnap" as const,
        displayName: "PwrSnap" as const,
        availability: "running" as const,
        configured: true,
      },
    }));
    const onEnabledChange = vi.fn(async () => undefined);
    render(
      <PwrSnapConnectionPrompt
        backend="codex"
        desktopApi={{
          connectPwrSnap,
          readPwrSnapConnectionStatus: async () => ({
            connectionId: "pwrsnap",
            displayName: "PwrSnap",
            availability: "running",
            configured: false,
          }),
        }}
        enabled={false}
        onEnabledChange={onEnabledChange}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Connect to PwrSnap" }),
    );
    const toggle = await screen.findByRole("switch", {
      name: "Use PwrSnap in this thread",
    });
    fireEvent.click(toggle);
    await waitFor(() => expect(onEnabledChange).toHaveBeenCalledWith(true));
  });

  it("offers to reconnect and explains why after PwrSnap revoked the session", async () => {
    const detail = PWRSNAP_SESSION_REVOKED_DETAIL;
    render(
      <PwrSnapConnectionPrompt
        backend="codex"
        desktopApi={{
          readPwrSnapConnectionStatus: async () => ({
            connectionId: "pwrsnap",
            displayName: "PwrSnap",
            availability: "running",
            configured: false,
            detail,
          }),
        }}
        enabled={false}
        onEnabledChange={vi.fn()}
      />,
    );

    expect(await screen.findByRole("button", { name: "Connect to PwrSnap" }))
      .toBeTruthy();
    expect(screen.getByText(detail)).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  // The mirror of PwrGit's assertion: this asset is full-bleed too, so scaling
  // it would overshoot the box the card reserves.
  it("leaves its icon unscaled", async () => {
    const { container } = render(
      <PwrSnapConnectionPrompt
        backend="codex"
        desktopApi={{
          readPwrSnapConnectionStatus: async () => ({
            connectionId: "pwrsnap" as const,
            displayName: "PwrSnap" as const,
            availability: "running" as const,
            configured: true,
          }),
        }}
        enabled={false}
        onEnabledChange={vi.fn()}
      />,
    );

    await screen.findByRole("switch");
    const icon = container.querySelector(".mcp-connection__icon");
    expect(icon?.className).toBe("mcp-connection__icon");
  });

  it("pairs with PwrSnap even while it is closed, and names Local Agent Access", async () => {
    const snapStatus: PwrSnapConnectionStatus = {
      connectionId: PWRSNAP_MCP_CONNECTION_ID,
      displayName: "PwrSnap",
      availability: "installed",
      configured: false,
    };
    const connectPwrSnap = vi.fn(async (): Promise<ConnectPwrSnapResponse> => ({
      outcome: "needs_local_agent_access",
      status: snapStatus,
    }));
    render(
      <PwrSnapConnectionPrompt
        backend="codex"
        desktopApi={{
          readPwrSnapConnectionStatus: async () => snapStatus,
          connectPwrSnap,
        }}
        enabled={false}
        onEnabledChange={vi.fn()}
      />,
    );

    expect(await screen.findByText("Screenshots your agents can use")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Connect to PwrSnap" }));
    });
    expect(connectPwrSnap).toHaveBeenCalledOnce();
    expect((await screen.findByRole("status")).textContent).toBe(
      "Turn on Local Agent Access in PwrSnap, then Connect again",
    );
  });
});
