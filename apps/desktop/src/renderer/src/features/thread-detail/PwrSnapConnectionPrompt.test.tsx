import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PwrSnapConnectionPrompt } from "./PwrSnapConnectionPrompt";

describe("PwrSnapConnectionPrompt", () => {
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

  it("keeps the switch visible but disabled for a non-MCP backend", async () => {
    render(
      <PwrSnapConnectionPrompt
        backend="grok"
        desktopApi={{
          readPwrSnapConnectionStatus: async () => ({
            connectionId: "pwrsnap",
            displayName: "PwrSnap",
            availability: "running",
            configured: true,
          }),
        }}
        enabled={true}
        onEnabledChange={vi.fn()}
      />,
    );

    const toggle = await screen.findByRole("switch", {
      name: "Use PwrSnap in this thread",
    });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Choose Codex or an ACP agent/)).toBeTruthy();
  });
});
