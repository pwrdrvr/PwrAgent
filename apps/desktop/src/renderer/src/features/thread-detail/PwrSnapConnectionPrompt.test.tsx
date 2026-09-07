import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

    expect(await screen.findByText("PwrSnap is available on Studio Mac"))
      .toBeTruthy();
    expect(screen.getByText(/where the thread runs/)).toBeTruthy();
    expect(screen.queryByText("Connect to PwrSnap")).toBeNull();
    expect(screen.queryByText("Get PwrSnap")).toBeNull();
    expect(screen.queryByText("Open PwrSnap")).toBeNull();

    fireEvent.click(screen.getByRole("switch", {
      name: "Enable PwrSnap on Studio Mac in this thread",
    }));
    await waitFor(() => expect(onEnabledChange).toHaveBeenCalledWith(true));
  });

  it("offers the PwrSnap download when the app is not installed", async () => {
    const openPwrSnapDownload = vi.fn(async () => ({ opened: true }));
    render(
      <PwrSnapConnectionPrompt
        backend="codex"
        desktopApi={{
          openPwrSnapDownload,
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

    expect(
      await screen.findByText("Screenshots your agents can actually use"),
    ).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Get PwrSnap" }));
    await waitFor(() => expect(openPwrSnapDownload).toHaveBeenCalledOnce());
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
    const detail =
      "PwrSnap revoked this connection. Choose Connect to PwrSnap on the New thread card to connect again.";
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
});
