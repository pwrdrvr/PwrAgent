import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { CloudflareSetup } from "../CloudflareSetup";
import type { CloudflareSetupRequest, CloudflareSetupStatus } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";

const connected: CloudflareSetupStatus = {
  connected: true, zoneName: "example.com", connectorInstalled: true,
  connectorRunning: false, clients: [],
};

describe("Cloudflare setup flow", () => {
  it("enables loopback ownership before provisioning and preserves an existing client role", async () => {
    const events: string[] = [];
    const call = vi.fn(async (request: CloudflareSetupRequest) => {
      if (request.action !== "status") events.push(request.action);
      return connected;
    });
    const write = vi.fn(async () => { events.push("bind"); return true; });
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" mode="client" onWriteConfig={write} onSettingsChanged={async () => {}} />);
    await screen.findByLabelText("Cloudflare public hostname");
    fireEvent.change(screen.getByLabelText("Cloudflare public hostname"), { target: { value: "federation.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Create protected endpoint" }));
    await waitFor(() => expect(events).toEqual(["bind", "provision"]));
    expect(write).toHaveBeenCalledWith({ federation: { mode: "dual", listenHost: "127.0.0.1", listenPort: 47830 } });
  });

  it("does not provision when enabling the listener fails", async () => {
    const call = vi.fn(async (_request: CloudflareSetupRequest) => connected);
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => false} onSettingsChanged={async () => {}} />);
    await screen.findByLabelText("Cloudflare public hostname");
    fireEvent.change(screen.getByLabelText("Cloudflare public hostname"), { target: { value: "federation.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Create protected endpoint" }));
    await screen.findByRole("alert");
    expect(call.mock.calls.every((args) => (args[0] as { action: string })?.action === "status")).toBe(true);
  });

  it("shows failed security evidence and requires an installed connector and API connection", async () => {
    const call = vi.fn(async () => ({ ...connected, tunnelId: "tunnel", hostname: "federation.example.com", phase: "Published",
      checks: [{ label: "WebSocket upgrade without certificate", passed: false, detail: "The request reached the gateway." }] }));
    render(<CloudflareSetup api={{ configureFederationCloudflare: call } as DesktopApi}
      listenPort="47830" onWriteConfig={async () => true} onSettingsChanged={async () => {}} />);
    await screen.findByText("FAIL");
    expect(screen.getByRole("button", { name: "Validate Endpoint Security" })).toBeDisabled();
    expect(screen.getByText("The request reached the gateway.")).toBeInTheDocument();
  });
});
