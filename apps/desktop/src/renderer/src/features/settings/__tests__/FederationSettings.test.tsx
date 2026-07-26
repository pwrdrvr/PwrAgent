import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopSettingsSnapshot,
  FederationHealthStatus,
  ReadFederationDiagnosticsResponse,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { FederationSettings } from "../FederationSettings";

afterEach(() => {
  cleanup();
});

describe("FederationSettings", () => {
  it("renders configured endpoints and sanitized peer health", async () => {
    const health: FederationHealthStatus = {
      enabled: true,
      role: "gateway",
      status: "listening",
      listenUrl: "ws://127.0.0.1:8765",
      publicUrl: "wss://pwragent.example.com/federation",
      peers: [
        {
          id: "client_one",
          label: "Studio Mac",
          role: "client",
          status: "connected",
          capabilities: ["thread_navigation"],
        },
      ],
    };
    const desktopApi: DesktopApi = {
      readFederationHealth: vi.fn(async () => ({ health })),
    };

    render(
      <FederationSettings
        desktopApi={desktopApi}
        onClearSecret={vi.fn(async () => true)}
        onReplaceSecret={vi.fn(async () => true)}
        saving={false}
        snapshot={settingsSnapshot()}
        onSettingsChanged={vi.fn()}
        onWriteConfig={vi.fn(async () => true)}
      />,
    );

    expect(await screen.findByText("Instance Federation")).toBeInTheDocument();
    expect(screen.getByText("ws://127.0.0.1:8765")).toBeInTheDocument();
    expect(
      screen.getByText("wss://pwragent.example.com/federation"),
    ).toBeInTheDocument();
    expect(screen.getByText("Studio Mac")).toBeInTheDocument();
    expect(screen.queryByText("secret-public-key")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(desktopApi.readFederationHealth).toHaveBeenCalledWith({}),
    );
  });

  it("falls back to the settings snapshot when diagnostics are unavailable", () => {
    render(
      <FederationSettings
        onClearSecret={vi.fn(async () => true)}
        onReplaceSecret={vi.fn(async () => true)}
        saving={false}
        snapshot={settingsSnapshot()}
        onSettingsChanged={vi.fn()}
        onWriteConfig={vi.fn(async () => true)}
      />,
    );

    expect(screen.getByText("Federation diagnostics are unavailable."))
      .toBeInTheDocument();
    expect(screen.getAllByText("gateway").length).toBeGreaterThan(0);
    expect(screen.getByText("wss://client.example.com/federation"))
      .toBeInTheDocument();
  });

  it("shows audit diagnostics and revokes peers without opening unavailable ones", async () => {
    const revokeFederationPeer = vi.fn(async () => ({
      peer: {
        id: "client_one",
        label: "Studio Mac",
        role: "client" as const,
        status: "revoked" as const,
        capabilities: [],
      },
    }));
    const openFederationWindow = vi.fn();
    const desktopApi: DesktopApi = {
      openFederationWindow,
      readFederationDiagnostics: vi.fn(
        async (): Promise<ReadFederationDiagnosticsResponse> => ({
          health: {
            enabled: true,
            role: "gateway",
            status: "listening",
            peers: [
              {
                id: "client_one",
                label: "Studio Mac",
                role: "client",
                status: "disconnected",
                capabilities: ["thread_navigation", "turn_control"],
                protocolVersion: 1,
                unavailableReason: "Transport closed.",
              },
            ],
          },
          events: [
            {
              eventId: 1,
              peerId: "client_one",
              kind: "rejected",
              createdAt: 1_000,
              detail: "bad_signature",
            },
          ],
        }),
      ),
      revokeFederationPeer,
    };

    render(
      <FederationSettings
        desktopApi={desktopApi}
        onClearSecret={vi.fn(async () => true)}
        onReplaceSecret={vi.fn(async () => true)}
        saving={false}
        snapshot={settingsSnapshot()}
        onSettingsChanged={vi.fn()}
        onWriteConfig={vi.fn(async () => true)}
      />,
    );

    expect(await screen.findByText("bad_signature")).toBeInTheDocument();
    expect(screen.getByText("Transport closed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

    await waitFor(() =>
      expect(revokeFederationPeer).toHaveBeenCalledWith({
        peerId: "client_one",
      }),
    );
    expect(openFederationWindow).not.toHaveBeenCalled();
  });

  it("stores Cloudflare client credentials before enabling edge policy", async () => {
    const onReplaceSecret = vi.fn(async () => true);
    const onWriteConfig = vi.fn(async () => true);
    render(
      <FederationSettings
        onClearSecret={vi.fn(async () => true)}
        onReplaceSecret={onReplaceSecret}
        saving={false}
        snapshot={settingsSnapshot()}
        onSettingsChanged={vi.fn()}
        onWriteConfig={onWriteConfig}
      />,
    );

    fireEvent.change(screen.getByRole("checkbox", { name: "mTLS" }), {
      target: { checked: true },
    });
    fireEvent.change(screen.getByPlaceholderText("PEM certificate"), {
      target: { value: "certificate-pem" },
    });
    fireEvent.change(screen.getByPlaceholderText("PEM private key"), {
      target: { value: "private-key-pem" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save edge policy" }));

    await waitFor(() =>
      expect(onReplaceSecret).toHaveBeenCalledWith(
        "federationCloudflareClientCertificate",
        "certificate-pem",
      ),
    );
    await waitFor(() => {
      expect(onReplaceSecret).toHaveBeenCalledWith(
        "federationCloudflareClientPrivateKey",
        "private-key-pem",
      );
      expect(onWriteConfig).toHaveBeenCalledWith({
        federation: {
          cloudflareMtlsEnabled: true,
          cloudflareAccessServiceAuthEnabled: false,
        },
      });
    });
  });
});

function settingsSnapshot(): DesktopSettingsSnapshot {
  return {
    federation: {
      mode: { value: "gateway", source: "config" },
      listenHost: { value: "127.0.0.1", source: "config" },
      listenPort: { value: 8765, source: "config" },
      publicUrl: {
        value: "wss://pwragent.example.com/federation",
        source: "config",
      },
      gatewayUrl: {
        value: "wss://client.example.com/federation",
        source: "config",
      },
      cloudflareMtlsEnabled: { value: true, source: "config" },
      cloudflareAccessServiceAuthEnabled: { value: false, source: "config" },
      cloudflareClientCertificate: {
        configured: false,
        source: "unset",
        writable: true,
      },
      cloudflareClientPrivateKey: {
        configured: false,
        source: "unset",
        writable: true,
      },
      cloudflareAccessClientId: {
        configured: false,
        source: "unset",
        writable: true,
      },
      cloudflareAccessClientSecret: {
        configured: false,
        source: "unset",
        writable: true,
      },
    },
  } as DesktopSettingsSnapshot;
}
