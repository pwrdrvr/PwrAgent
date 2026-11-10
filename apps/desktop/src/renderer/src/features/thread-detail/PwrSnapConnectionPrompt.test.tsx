import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  PWRSNAP_MCP_CONNECTION_ID,
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

  it("offers a per-thread switch once a relay install is running, and no Connect step", async () => {
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
        onEnabledChange={onEnabledChange}
      />,
    );

    fireEvent.click(await screen.findByRole("switch", { name: "Use PwrSnap in this thread" }));
    await waitFor(() => expect(onEnabledChange).toHaveBeenCalledWith(true));
    expect(screen.queryByRole("button", { name: /Connect/ })).toBeNull();
  });

  // An install without the relay cannot be connected or fixed by opening it,
  // whether or not it is running: the only way forward is an update.
  it.each(["running", "installed"] as const)(
    "sends an older PwrSnap that is %s to the update, never to Connect or Open",
    async (availability) => {
      const open = vi.spyOn(window, "open").mockImplementation(() => null);
      const openPwrSnap = vi.fn(async () => ({ opened: true }));
      const snapStatus: PwrSnapConnectionStatus = {
        connectionId: PWRSNAP_MCP_CONNECTION_ID,
        displayName: "PwrSnap",
        availability,
        configured: false,
        detail: "Update PwrSnap to 1.3.0 or later, then turn on Local Agent Access.",
      };
      try {
        render(
          <PwrSnapConnectionPrompt
            backend="codex"
            desktopApi={{ readPwrSnapConnectionStatus: async () => snapStatus, openPwrSnap }}
            enabled={false}
            onEnabledChange={vi.fn()}
          />,
        );

        expect(await screen.findByText(snapStatus.detail!)).toBeTruthy();
        expect(screen.queryByRole("switch")).toBeNull();
        expect(screen.queryByRole("button", { name: /Connect|Open PwrSnap/ })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Update PwrSnap" }));
        expect(open).toHaveBeenCalledWith("https://pwrsnap.com", "_blank", "noopener,noreferrer");
        expect(openPwrSnap).not.toHaveBeenCalled();
      } finally {
        open.mockRestore();
      }
    },
  );

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

  it("asks for a relay install to be opened while it is closed", async () => {
    const detail = "Open PwrSnap and turn on Local Agent Access to connect agents.";
    const openPwrSnap = vi.fn(async () => ({ opened: true }));
    render(
        <PwrSnapConnectionPrompt
          backend="codex"
          desktopApi={{
            readPwrSnapConnectionStatus: async () => ({
              connectionId: PWRSNAP_MCP_CONNECTION_ID,
              displayName: "PwrSnap",
              availability: "installed",
              configured: true,
              detail,
            }),
            openPwrSnap,
          }}
          enabled={false}
          onEnabledChange={vi.fn()}
        />,
      );

    expect(await screen.findByText(detail)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Connect/ })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open PwrSnap" }));
    });
    expect(openPwrSnap).toHaveBeenCalledOnce();
  });
});
