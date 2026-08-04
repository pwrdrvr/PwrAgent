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
import type {
  DesktopSettingsConfigPatch,
  DesktopSettingsSnapshot,
  FederationHealthStatus,
  ReadFederationDiagnosticsResponse,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { FederationSettings } from "../FederationSettings";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
    expect(screen.getByText("PwrAgent Encrypted Transport")).toBeInTheDocument();
    expect(
      screen.getByText("Noise IK · X25519 · AES-256-GCM · SHA-256"),
    ).toBeInTheDocument();
    expect(screen.getByText("Stored securely")).toBeInTheDocument();
    expect(screen.getByText("ws://127.0.0.1:8765")).toBeInTheDocument();
    expect(
      screen.getByText("wss://pwragent.example.com/federation"),
    ).toBeInTheDocument();
    expect(screen.getByText("Studio Mac")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke" }))
      .not.toBeInTheDocument();
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
                canRevoke: true,
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

  it("refreshes stale connection health while settings remains open", async () => {
    vi.useFakeTimers();
    const connected: FederationHealthStatus = {
      enabled: true,
      role: "client",
      status: "connected",
      peers: [
        {
          id: "gateway_one",
          label: "Studio Mac",
          role: "gateway",
          status: "connected",
          capabilities: ["remote_window"],
        },
      ],
    };
    const disconnected: FederationHealthStatus = {
      ...connected,
      status: "connecting",
      unavailableReason: "Federation gateway connection closed.",
      peers: connected.peers.map((peer) => ({
        ...peer,
        status: "disconnected",
        unavailableReason: "Federation gateway connection closed.",
      })),
    };
    const readFederationHealth = vi.fn()
      .mockResolvedValueOnce({ health: connected })
      .mockResolvedValue({ health: disconnected });
    const view = render(
      <FederationSettings
        desktopApi={{
          openFederationWindow: vi.fn(),
          readFederationHealth,
        }}
        onClearSecret={vi.fn(async () => true)}
        onReplaceSecret={vi.fn(async () => true)}
        saving={false}
        snapshot={settingsSnapshot()}
        onSettingsChanged={vi.fn()}
        onWriteConfig={vi.fn(async () => true)}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open" })).toBeEnabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(screen.getByText("Connecting")).toBeInTheDocument();
    expect(screen.getAllByText("Federation gateway connection closed."))
      .toHaveLength(2);
    expect(screen.getByRole("button", { name: "Open" })).toBeDisabled();
    view.unmount();
    vi.useRealTimers();
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

  it("requires public exposure acknowledgement before setting up Tailscale Funnel", async () => {
    const events: string[] = [];
    const status = {
      installed: true,
      connected: true,
      version: "1.98.10",
      dnsName: "studio.example.ts.net",
      tailnetName: "Example Tailnet",
      serveConfigured: false,
      funnelConfigured: false,
      gatewayUrl: "wss://studio.example.ts.net/pwragent-federation",
    };
    const configureFederationTailscale = vi.fn(async () => {
      events.push("publish");
      return {
        status: { ...status, funnelConfigured: true },
        gatewayUrl: status.gatewayUrl,
      };
    });
    const onWriteConfig = vi.fn(async (patch: DesktopSettingsConfigPatch) => {
      events.push(patch.federation?.publicUrl ? "save-url" : "bind-listener");
      return true;
    });
    render(
      <FederationSettings
        desktopApi={{
          configureFederationTailscale,
          readFederationHealth: vi.fn(async () => ({
            health: {
              enabled: true,
              role: "gateway" as const,
              status: "listening" as const,
              listenUrl: "ws://127.0.0.1:8765",
              peers: [],
            },
          })),
          readFederationTailscaleStatus: vi.fn(async () => ({ status })),
        }}
        onClearSecret={vi.fn(async () => true)}
        onReplaceSecret={vi.fn(async () => true)}
        saving={false}
        snapshot={settingsSnapshot()}
        onSettingsChanged={vi.fn()}
        onWriteConfig={onWriteConfig}
      />,
    );

    expect(await screen.findByText("Example Tailnet")).toBeInTheDocument();
    const funnelButton = screen.getByRole("button", {
      name: "Set up Tailscale Funnel",
    });
    expect(funnelButton).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", {
      name: "Acknowledge public Funnel exposure",
    }));
    expect(funnelButton).toBeEnabled();
    fireEvent.click(funnelButton);

    await waitFor(() =>
      expect(onWriteConfig).toHaveBeenNthCalledWith(1, {
        federation: {
          mode: "gateway",
          listenHost: "127.0.0.1",
          listenPort: 8765,
        },
      }),
    );
    await waitFor(() =>
      expect(configureFederationTailscale).toHaveBeenCalledWith({
        mode: "funnel",
        listenPort: 8765,
      }),
    );
    await waitFor(() =>
      expect(onWriteConfig).toHaveBeenNthCalledWith(2, {
        federation: {
          publicUrl: "wss://studio.example.ts.net/pwragent-federation",
        },
      }),
    );
    expect(events).toEqual(["bind-listener", "publish", "save-url"]);
  });

  it("does not publish a Tailscale route when the listener cannot bind", async () => {
    const status = {
      installed: true,
      connected: true,
      serveConfigured: false,
      funnelConfigured: false,
      gatewayUrl: "wss://studio.example.ts.net/pwragent-federation",
    };
    const configureFederationTailscale = vi.fn();
    render(
      <FederationSettings
        desktopApi={{
          configureFederationTailscale,
          readFederationHealth: vi.fn(async () => ({
            health: {
              enabled: true,
              role: "gateway" as const,
              status: "degraded" as const,
              unavailableReason: "listen EADDRINUSE: address already in use",
              peers: [],
            },
          })),
          readFederationTailscaleStatus: vi.fn(async () => ({ status })),
        }}
        onClearSecret={vi.fn(async () => true)}
        onReplaceSecret={vi.fn(async () => true)}
        saving={false}
        snapshot={settingsSnapshot()}
        onSettingsChanged={vi.fn()}
        onWriteConfig={vi.fn(async () => true)}
      />,
    );

    const serveButton = await screen.findByRole("button", {
      name: "Set up Tailscale Serve",
    });
    await waitFor(() => expect(serveButton).toBeEnabled());
    fireEvent.click(serveButton);

    expect(await screen.findByText(
      "PwrAgent did not bind the selected loopback port. Tailscale was not changed.",
    )).toBeInTheDocument();
    expect(configureFederationTailscale).not.toHaveBeenCalled();
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
      noiseStaticPrivateKey: {
        configured: true,
        source: "keychain",
        writable: true,
      },
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
