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
import { useState } from "react";
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
  it("saves the compression toggle with federation settings", async () => {
    const onWriteConfig = vi.fn(async () => true);
    render(
      <FederationSettings
        desktopApi={{ readFederationHealth: vi.fn(async () => ({
          health: { enabled: false, role: "client", status: "disabled", peers: [] } satisfies FederationHealthStatus,
        })) }}
        onClearSecret={vi.fn(async () => true)}
        onReplaceSecret={vi.fn(async () => true)}
        saving={false}
        snapshot={settingsSnapshot()}
        onSettingsChanged={vi.fn()}
        onWriteConfig={onWriteConfig}
      />,
    );
    const toggle = screen.getByRole("switch", { name: "Protocol compression" });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Save federation settings" }));
    await waitFor(() => expect(onWriteConfig).toHaveBeenCalledWith(
      expect.objectContaining({ federation: expect.objectContaining({ compressionEnabled: false }) }),
    ));
  });
  // The pane shipped on browser-default controls once. Nothing else here
  // reads a class, so without this the next bare <input> passes every test
  // and only shows up by eye.
  it("keeps every editable control on the settings control classes", async () => {
    const health: FederationHealthStatus = {
      enabled: true,
      role: "gateway",
      status: "listening",
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
    render(
      <FederationSettings
        desktopApi={{ readFederationHealth: vi.fn(async () => ({ health })) }}
        onClearSecret={vi.fn(async () => true)}
        onReplaceSecret={vi.fn(async () => true)}
        saving={false}
        snapshot={settingsSnapshot()}
        onSettingsChanged={vi.fn()}
        onWriteConfig={vi.fn(async () => true)}
      />,
    );
    // The peer row's celestial picker only exists once health resolves.
    expect(
      await screen.findByLabelText("Celestial icon for Studio Mac"),
    ).toBeInTheDocument();

    const controls = Array.from(
      document.querySelectorAll<HTMLElement>("input, select, textarea"),
    ).filter((control) => {
      // Checkboxes and radios are acknowledgements and choices, not fields:
      // they carry their own tinted styling, not `settings-input`.
      const type = control.getAttribute("type");
      return type !== "checkbox" && type !== "radio";
    });
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(
        `${control.tagName.toLowerCase()}[${control.getAttribute("aria-label")}]: ${control.className}`,
      ).toMatch(/\bsettings-(input|select)\b/);
    }
  });

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

  it("explains remote actions and shows current connection timing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T21:07:05.000Z"));
    const lastConnectedAt = Date.now() - 65_000;
    const openFederationWindow = vi.fn();
    const health: FederationHealthStatus = {
      enabled: true,
      role: "client",
      status: "connected",
      peers: [
        {
          id: "gateway_one",
          label: "Mac Mini",
          role: "gateway",
          status: "connected",
          capabilities: [
            "remote_window",
            "thread_navigation",
            "turn_control",
            "scheduled_actions",
            "pending_request_control",
          ],
          protocolVersion: 1,
          lastConnectedAt,
          lastActivityAt: lastConnectedAt,
        },
      ],
    };

    render(
      <FederationSettings
        desktopApi={{
          openFederationWindow,
          readFederationDiagnostics: vi.fn(async () => ({
            health,
            events: [],
          })),
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
    expect(screen.getByText(
      "Choose Browse remote threads to open a separate window for a connected instance. Threads, prompts, approvals, environments, and files stay on that machine.",
    )).toBeInTheDocument();
    expect(screen.getByText(/Current session 1m 5s/)).toBeInTheDocument();
    expect(screen.getByText(
      /Available: open a remote workspace · browse and create threads/,
    )).toBeInTheDocument();
    expect(screen.getByText(/schedule and manage messages/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", {
      name: "Browse remote threads",
    }));
    // The display label is composed main-side from the peer record; the
    // request carries only the target.
    expect(openFederationWindow).toHaveBeenCalledWith({
      target: { scope: "remote", instanceId: "gateway_one" },
    });
  });

  it("shows locally counted wire transfer for peers that have moved bytes", async () => {
    const health: FederationHealthStatus = {
      enabled: true,
      role: "gateway",
      status: "listening",
      peers: [
        {
          id: "pwr_studio",
          label: "Studio Mac",
          role: "client",
          status: "connected",
          capabilities: ["thread_navigation"],
          transfer: {
            bytesSent: 512_000,
            bytesReceived: 209_715_200,
            envelopesSent: 1_200,
            envelopesReceived: 3_400,
            since: Date.parse("2026-08-08T09:00:00.000Z"),
            lastActivityAt: Date.parse("2026-08-08T09:45:00.000Z"),
          },
        },
        {
          id: "pwr_quiet",
          label: "Quiet Mini",
          role: "client",
          status: "connected",
          capabilities: ["thread_navigation"],
          transfer: {
            bytesSent: 900,
            bytesReceived: 5_452_595,
            envelopesSent: 4,
            envelopesReceived: 9,
            since: Date.parse("2026-08-08T09:30:00.000Z"),
            lastActivityAt: Date.parse("2026-08-08T09:31:00.000Z"),
          },
        },
        {
          id: "pwr_idle",
          label: "Idle Mini",
          role: "client",
          status: "disconnected",
          capabilities: [],
        },
      ],
    };

    render(
      <FederationSettings
        desktopApi={{
          readFederationDiagnostics: vi.fn(async () => ({
            health,
            events: [],
          })),
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
    // Whole-number MB once the magnitude carries the signal...
    expect(
      screen.getByText(/^Transferred ↑ 500 KB · ↓ 200 MB$/),
    ).toBeInTheDocument();
    // ...one decimal while leading digits are scarce.
    expect(
      screen.getByText(/^Transferred ↑ 900 B · ↓ 5\.2 MB$/),
    ).toBeInTheDocument();
    // Screen readers get worded directions, and the envelope count +
    // counting start live in the long form instead of the visible row.
    expect(
      screen.getByLabelText(/^Sent 500 KB, received 200 MB across 4,600 envelopes since /),
    ).toBeInTheDocument();
    // A peer with no observed traffic gets no transfer line at all.
    expect(screen.getAllByText(/Transferred ↑/)).toHaveLength(2);
  });

  it("saves the ordered gateway endpoint list", async () => {
    const onWriteConfig = vi.fn(async (_patch: DesktopSettingsConfigPatch) => true);
    render(
      <FederationSettings
        desktopApi={{
          readFederationHealth: vi.fn(async () => ({
            health: {
              enabled: true,
              role: "client",
              status: "disconnected",
              peers: [],
            } satisfies FederationHealthStatus,
          })),
        }}
        onClearSecret={vi.fn(async () => true)}
        onReplaceSecret={vi.fn(async () => true)}
        saving={false}
        snapshot={settingsSnapshot()}
        onSettingsChanged={vi.fn()}
        onWriteConfig={onWriteConfig}
      />,
    );

    const editor = screen.getByLabelText("Gateway endpoints");
    fireEvent.change(editor, {
      target: {
        value: [
          "ws://192.168.1.20:47830",
          "wss://studio.example.ts.net/pwragent-federation",
          "ssh://ops@gateway.lan:2222/?forward=127.0.0.1:47830",
        ].join("\n"),
      },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save federation settings" }),
    );

    await waitFor(() => expect(onWriteConfig).toHaveBeenCalled());
    expect(onWriteConfig.mock.calls[0][0].federation?.gatewayEndpoints).toEqual([
      "ws://192.168.1.20:47830",
      "wss://studio.example.ts.net/pwragent-federation",
      "ssh://ops@gateway.lan:2222/?forward=127.0.0.1:47830",
    ]);
  });

  it("saves the instance purpose notes", async () => {
    const onWriteConfig = vi.fn(async (_patch: DesktopSettingsConfigPatch) => true);
    render(
      <FederationSettings
        desktopApi={{
          readFederationHealth: vi.fn(async () => ({
            health: {
              enabled: true,
              role: "client",
              status: "disconnected",
              peers: [],
            } satisfies FederationHealthStatus,
          })),
        }}
        onClearSecret={vi.fn(async () => true)}
        onReplaceSecret={vi.fn(async () => true)}
        saving={false}
        snapshot={settingsSnapshot()}
        onSettingsChanged={vi.fn()}
        onWriteConfig={onWriteConfig}
      />,
    );

    fireEvent.change(screen.getByLabelText("Purpose notes"), {
      target: { value: "Studio Mac — PwrSnap dev + screen recording" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save federation settings" }),
    );

    await waitFor(() => expect(onWriteConfig).toHaveBeenCalled());
    expect(onWriteConfig.mock.calls[0][0].federation?.instanceNotes).toBe(
      "Studio Mac — PwrSnap dev + screen recording",
    );
  });

  it("rejects an invalid gateway endpoint before saving", async () => {
    const onWriteConfig = vi.fn(async () => true);
    render(
      <FederationSettings
        desktopApi={{
          readFederationHealth: vi.fn(async () => ({
            health: {
              enabled: true,
              role: "client",
              status: "disconnected",
              peers: [],
            } satisfies FederationHealthStatus,
          })),
        }}
        onClearSecret={vi.fn(async () => true)}
        onReplaceSecret={vi.fn(async () => true)}
        saving={false}
        snapshot={settingsSnapshot()}
        onSettingsChanged={vi.fn()}
        onWriteConfig={onWriteConfig}
      />,
    );

    fireEvent.change(screen.getByLabelText("Gateway endpoints"), {
      target: { value: "https://not-a-federation-endpoint.example" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save federation settings" }),
    );

    expect(await screen.findByText(
      /must be a ws:\/\/, wss:\/\/, or ssh:\/\/ URL/,
    )).toBeInTheDocument();
    expect(onWriteConfig).not.toHaveBeenCalled();
  });

  it("shows per-endpoint connection status for client mode", async () => {
    const health: FederationHealthStatus = {
      enabled: true,
      role: "client",
      status: "connected",
      gatewayEndpoints: [
        {
          url: "ws://192.168.1.20:47830",
          state: "failed",
          lastError: "connect_failed",
        },
        {
          url: "wss://studio.example.ts.net/pwragent-federation",
          state: "active",
          lastConnectedAt: Date.now(),
        },
        {
          url: "wss://federation.example.com",
          state: "idle",
        },
      ],
      peers: [],
    };
    render(
      <FederationSettings
        desktopApi={{
          readFederationDiagnostics: vi.fn(async () => ({
            health,
            events: [],
          })),
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
    expect(screen.getByText("ws://192.168.1.20:47830")).toBeInTheDocument();
    expect(screen.getByText(/^Failed/)).toBeInTheDocument();
    expect(screen.getByText("connect_failed")).toBeInTheDocument();
    expect(screen.getByText(/^Active · Connected/)).toBeInTheDocument();
    expect(
      screen.getByText("wss://federation.example.com"),
    ).toBeInTheDocument();
    expect(screen.getByText("Idle")).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "Browse remote threads" }))
      .toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    // With no pin-impact reader wired (older preload), the confirm stays a
    // plain one — never a silent forget.
    const confirm = await screen.findByRole("button", {
      name: "Confirm revoke",
    });
    expect(
      screen.queryByRole("button", { name: "Revoke and forget threads" }),
    ).toBeNull();
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(revokeFederationPeer).toHaveBeenCalledWith({
        peerId: "client_one",
        pinDisposition: "remember",
      }),
    );
    expect(openFederationWindow).not.toHaveBeenCalled();
  });

  it("drives the celestial icon pickers: override, reset to auto, pending lock, invalid guard", async () => {
    const health: FederationHealthStatus = {
      enabled: true,
      role: "gateway",
      status: "listening",
      instanceId: "gateway_one",
      localCelestialIcon: "sun",
      peers: [
        {
          id: "client_one",
          label: "Studio Mac",
          role: "client",
          status: "connected",
          capabilities: ["thread_navigation"],
          celestialIcon: "moon",
        },
      ],
    };
    let resolveSet: (response: { assignments: [] }) => void = () => undefined;
    const setCelestialIcon = vi.fn(
      () =>
        new Promise<{ assignments: [] }>((resolve) => {
          resolveSet = resolve;
        }),
    );
    const desktopApi: DesktopApi = {
      readFederationHealth: vi.fn(async () => ({ health })),
      setCelestialIcon,
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

    const peerPicker = await screen.findByLabelText(
      "Celestial icon for Studio Mac",
    );
    fireEvent.change(peerPicker, { target: { value: "black-hole" } });
    expect(setCelestialIcon).toHaveBeenCalledWith({
      instanceId: "client_one",
      icon: "black-hole",
    });
    // The picker locks while the override request is in flight, then frees.
    expect(peerPicker).toBeDisabled();
    await act(async () => {
      resolveSet({ assignments: [] });
    });
    await waitFor(() => expect(peerPicker).not.toBeDisabled());

    // The Auto option is selectable and clears the override (null icon).
    const localPicker = screen.getByLabelText("Instance icon");
    expect(
      within(localPicker).getByRole("option", { name: "Auto" }),
    ).not.toBeDisabled();
    fireEvent.change(localPicker, { target: { value: "" } });
    expect(setCelestialIcon).toHaveBeenLastCalledWith({
      instanceId: "gateway_one",
      icon: null,
    });
    await act(async () => {
      resolveSet({ assignments: [] });
    });
    await waitFor(() => expect(localPicker).not.toBeDisabled());

    // A non-empty value that is not a known icon id never reaches the API.
    const callsBefore = setCelestialIcon.mock.calls.length;
    Object.defineProperty(peerPicker, "value", {
      configurable: true,
      get: () => "comet",
    });
    fireEvent.change(peerPicker);
    expect(setCelestialIcon.mock.calls.length).toBe(callsBefore);
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
    expect(screen.getByRole("button", { name: "Browse remote threads" }))
      .toBeEnabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(screen.getByText("Connecting")).toBeInTheDocument();
    expect(screen.getAllByText("Federation gateway connection closed."))
      .toHaveLength(2);
    expect(screen.getByRole("button", { name: "Browse remote threads" }))
      .toBeDisabled();
    view.unmount();
    vi.useRealTimers();
  });

  it("stores Cloudflare client credentials before enabling edge policy", async () => {
    const onReplaceSecret = vi.fn(async () => true);
    const onWriteConfig = vi.fn(async () => true);
    const snapshot = settingsSnapshot();
    snapshot.federation.cloudflareMtlsEnabled = { value: false, source: "default" };
    render(
      <FederationSettings
        onClearSecret={vi.fn(async () => true)}
        onReplaceSecret={onReplaceSecret}
        saving={false}
        snapshot={snapshot}
        onSettingsChanged={vi.fn()}
        onWriteConfig={onWriteConfig}
      />,
    );

    const mtls = screen.getByRole("switch", { name: "mTLS" });
    expect(mtls).toHaveAttribute("aria-checked", "false");
    fireEvent.click(mtls);
    expect(mtls).toHaveAttribute("aria-checked", "true");
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
          cloudflareEndpoint: "",
          cloudflareMtlsEnabled: true,
          cloudflareAccessServiceAuthEnabled: false,
          cloudflareAccessOAuthEnabled: false,
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

  it.each(["", "not-a-port", "0", "65536", "47830.5"])(
    "rejects invalid Tailscale listen port %j before saving settings",
    async (listenPort) => {
      const status = {
        installed: true,
        connected: true,
        serveConfigured: false,
        funnelConfigured: false,
        gatewayUrl: "wss://studio.example.ts.net/pwragent-federation",
      };
      const configureFederationTailscale = vi.fn();
      const onWriteConfig = vi.fn(async () => true);
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

      fireEvent.change(screen.getByDisplayValue("8765"), {
        target: { value: listenPort },
      });
      const serveButton = await screen.findByRole("button", {
        name: "Set up Tailscale Serve",
      });
      fireEvent.click(serveButton);

      expect(await screen.findByText(
        "Listen port must be an integer between 1 and 65535.",
      )).toBeInTheDocument();
      expect(onWriteConfig).not.toHaveBeenCalled();
      expect(configureFederationTailscale).not.toHaveBeenCalled();
    },
  );

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

  it("shows the listener Tailscale wrote and keeps unrelated edits", async () => {
    const status = {
      installed: true,
      connected: true,
      serveConfigured: false,
      funnelConfigured: false,
      gatewayUrl: "wss://studio.example.ts.net/pwragent-federation",
    };
    const desktopApi = {
      configureFederationTailscale: vi.fn(async () => ({
        status: { ...status, serveConfigured: true },
        gatewayUrl: status.gatewayUrl,
      })),
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
    } as unknown as DesktopApi;
    function Harness() {
      const [snapshot, setSnapshot] = useState(settingsSnapshot());
      return (
        <FederationSettings
          desktopApi={desktopApi}
          onClearSecret={vi.fn(async () => true)}
          onReplaceSecret={vi.fn(async () => true)}
          saving={false}
          snapshot={snapshot}
          onSettingsChanged={vi.fn()}
          onWriteConfig={async (patch) => {
            setSnapshot((current) => withFederationPatch(current, patch));
            return true;
          }}
        />
      );
    }
    render(<Harness />);

    fireEvent.change(await screen.findByLabelText("Listen host"), {
      target: { value: "0.0.0.0" },
    });
    fireEvent.change(screen.getByLabelText("Purpose notes"), {
      target: { value: "Studio rig" },
    });
    const serveButton = await screen.findByRole("button", {
      name: "Set up Tailscale Serve",
    });
    await waitFor(() => expect(serveButton).toBeEnabled());
    fireEvent.click(serveButton);

    // Tailscale forces the loopback listener and publishes its own URL, so
    // those fields show what was written rather than the edit it replaced.
    await waitFor(() =>
      expect(screen.getByLabelText("Listen host")).toHaveValue("127.0.0.1"),
    );
    expect(screen.getByLabelText("Public URL")).toHaveValue(status.gatewayUrl);
    // A field it did not write keeps the operator's unsaved edit.
    expect(screen.getByLabelText("Purpose notes")).toHaveValue("Studio rig");
  });

  it("disables fields that do not apply to the selected mode", async () => {
    const gatewaySnapshot = settingsSnapshot();
    const { unmount } = render(
      <FederationSettings
        desktopApi={{
          generateFederationInvite: vi.fn(),
          readFederationHealth: vi.fn(async () => ({
            health: {
              enabled: true,
              role: "gateway" as const,
              status: "listening" as const,
              peers: [],
            },
          })),
        }}
        onClearSecret={vi.fn(async () => true)}
        onReplaceSecret={vi.fn(async () => true)}
        saving={false}
        snapshot={gatewaySnapshot}
        onSettingsChanged={vi.fn()}
        onWriteConfig={vi.fn(async () => true)}
      />,
    );

    expect(await screen.findByLabelText("Listen host")).toBeEnabled();
    expect(screen.getByLabelText("Listen port")).toBeEnabled();
    expect(screen.getByLabelText("Public URL")).toBeEnabled();
    expect(screen.getByLabelText("Gateway endpoints")).toBeDisabled();
    expect(screen.getByLabelText("Advertised endpoints")).toHaveAttribute(
      "placeholder",
      "ws://gateway.tailnet.ts.net:47830",
    );
    expect(screen.getByText(
      /Existing clients keep their current list/,
    )).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Generate invite" }),
    ).toBeEnabled();
    unmount();

    const clientSnapshot: DesktopSettingsSnapshot = {
      ...gatewaySnapshot,
      federation: {
        ...gatewaySnapshot.federation,
        mode: { value: "client", source: "config" },
      },
    };
    render(
      <FederationSettings
        desktopApi={{
          generateFederationInvite: vi.fn(),
          readFederationHealth: vi.fn(async () => ({
            health: {
              enabled: true,
              role: "client" as const,
              status: "connecting" as const,
              peers: [],
            },
          })),
        }}
        onClearSecret={vi.fn(async () => true)}
        onReplaceSecret={vi.fn(async () => true)}
        saving={false}
        snapshot={clientSnapshot}
        onSettingsChanged={vi.fn()}
        onWriteConfig={vi.fn(async () => true)}
      />,
    );

    expect(await screen.findByLabelText("Listen host")).toBeDisabled();
    expect(screen.getByLabelText("Listen port")).toBeDisabled();
    expect(screen.getByLabelText("Public URL")).toBeDisabled();
    expect(screen.getByLabelText("Gateway endpoints")).toBeEnabled();
    expect(screen.getByLabelText("Gateway endpoints")).toHaveAttribute(
      "placeholder",
      "ws://gateway.tailnet.ts.net:47830",
    );
    expect(screen.getByText(
      /Add or reorder them after enrollment without re-inviting/,
    )).toBeInTheDocument();
    // Only the listening side issues invites.
    expect(
      screen.getByRole("button", { name: "Generate invite" }),
    ).toBeDisabled();
  });

  it("keeps an unsaved edit through a settings refresh and adopts the rest", async () => {
    // The refresh that took the port back: any config write, from any section
    // or window, replaces the snapshot, and the form used to copy all of it
    // back over whatever the operator had typed.
    const onWriteConfig = vi.fn(async () => true);
    const desktopApi = federationHealthApi();
    const saved = settingsSnapshot();
    const view = render(
      <FederationSettings
        desktopApi={desktopApi}
        onClearSecret={vi.fn(async () => true)}
        onReplaceSecret={vi.fn(async () => true)}
        saving={false}
        snapshot={saved}
        onSettingsChanged={vi.fn()}
        onWriteConfig={onWriteConfig}
      />,
    );

    const listenPort = await screen.findByLabelText("Listen port");
    fireEvent.change(listenPort, { target: { value: "8766" } });
    expect(screen.getByText("Unsaved")).toBeInTheDocument();

    // Typing the saved value back is not an edit — otherwise every later
    // navigation raises a prompt with nothing to save.
    fireEvent.change(listenPort, { target: { value: "8765" } });
    expect(screen.getByText("Editable")).toBeInTheDocument();
    fireEvent.change(listenPort, { target: { value: "8766" } });

    // Another section's write lands: a new Public URL, and the port as it is
    // still saved on disk.
    const refreshed: DesktopSettingsSnapshot = {
      ...saved,
      federation: {
        ...saved.federation,
        publicUrl: { value: "wss://tailnet.example/federation", source: "config" },
      },
    };
    view.rerender(
      <FederationSettings
        desktopApi={desktopApi}
        onClearSecret={vi.fn(async () => true)}
        onReplaceSecret={vi.fn(async () => true)}
        saving={false}
        snapshot={refreshed}
        onSettingsChanged={vi.fn()}
        onWriteConfig={onWriteConfig}
      />,
    );

    expect(screen.getByLabelText("Listen port")).toHaveValue("8766");
    // A field nobody touched still follows what is saved.
    expect(screen.getByLabelText("Public URL")).toHaveValue(
      "wss://tailnet.example/federation",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Save federation settings" }),
    );
    await waitFor(() => expect(onWriteConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        federation: expect.objectContaining({ listenPort: 8766 }),
      }),
    ));

    // Saved, so the field goes back to following the snapshot.
    const applied: DesktopSettingsSnapshot = {
      ...refreshed,
      federation: {
        ...refreshed.federation,
        listenPort: { value: 9000, source: "config" },
      },
    };
    view.rerender(
      <FederationSettings
        desktopApi={desktopApi}
        onClearSecret={vi.fn(async () => true)}
        onReplaceSecret={vi.fn(async () => true)}
        saving={false}
        snapshot={applied}
        onSettingsChanged={vi.fn()}
        onWriteConfig={onWriteConfig}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Listen port")).toHaveValue("9000"),
    );
    expect(screen.getByText("Editable")).toBeInTheDocument();
  });

  it("creates the Cloudflare endpoint on the listener port it shows", async () => {
    // The incident: the port was edited but not saved, Cloudflare setup showed
    // the edit, and Create ran against the saved port — on a port another
    // profile's gateway already held.
    const configureFederationCloudflare = vi.fn(async () => ({
      connected: true,
      zoneName: "example.com",
      connectorInstalled: true,
      connectorRunning: false,
      clients: [],
    }));
    const onWriteConfig = vi.fn(async () => true);
    render(
      <FederationSettings
        desktopApi={{
          ...federationHealthApi(),
          configureFederationCloudflare,
        } as DesktopApi}
        onClearSecret={vi.fn(async () => true)}
        onReplaceSecret={vi.fn(async () => true)}
        saving={false}
        snapshot={settingsSnapshot()}
        onSettingsChanged={vi.fn()}
        onWriteConfig={onWriteConfig}
      />,
    );

    fireEvent.change(await screen.findByLabelText("Listen port"), {
      target: { value: "8766" },
    });
    const statement = await screen.findByText(
      /Creating the endpoint uses this profile.s saved listener port/,
    );
    expect(statement).toHaveTextContent("127.0.0.1:8765");

    fireEvent.change(screen.getByLabelText("Cloudflare public hostname"), {
      target: { value: "federation.example.com" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create protected endpoint" }),
    );

    await waitFor(() => expect(configureFederationCloudflare).toHaveBeenCalledWith(
      expect.objectContaining({ action: "provision", listenPort: 8765 }),
    ));
    expect(onWriteConfig).toHaveBeenCalledWith({
      federation: { mode: "gateway", listenHost: "127.0.0.1", listenPort: 8765 },
    });
    // And the edit is still there to save deliberately.
    expect(screen.getByLabelText("Listen port")).toHaveValue("8766");
  });

  it("shows gateway enrollment and forgets it after confirmation", async () => {
    const resetFederationEnrollment = vi.fn(async () => ({ cleared: true }));
    const gatewaySnapshot = settingsSnapshot();
    const clientSnapshot: DesktopSettingsSnapshot = {
      ...gatewaySnapshot,
      federation: {
        ...gatewaySnapshot.federation,
        mode: { value: "client", source: "config" },
      },
    };
    const health: FederationHealthStatus = {
      enabled: true,
      role: "client",
      status: "rejected",
      unavailableReason: "unknown_peer",
      peers: [],
      clientEnrollment: {
        gatewayInstanceId: "pwr_gateway_one",
        gatewayUrl: "ws://192.168.6.163:47830",
        enrolledAt: Date.parse("2026-08-01T12:00:00Z"),
        pendingInvite: false,
      },
    };

    render(
      <FederationSettings
        desktopApi={{
          readFederationDiagnostics: vi.fn(async () => ({
            health,
            events: [],
          })),
          resetFederationEnrollment,
        }}
        onClearSecret={vi.fn(async () => true)}
        onReplaceSecret={vi.fn(async () => true)}
        saving={false}
        snapshot={clientSnapshot}
        onSettingsChanged={vi.fn()}
        onWriteConfig={vi.fn(async () => true)}
      />,
    );

    expect(await screen.findByText("Gateway Enrollment")).toBeInTheDocument();
    expect(screen.getByText("pwr_gateway_one")).toBeInTheDocument();
    // Auth-class failures also surface remediation guidance.
    expect(
      screen.getByText(
        "This instance is not enrolled with the gateway anymore. Generate a fresh invite on the gateway and import it here.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Forget gateway" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm forget" }),
    );
    await waitFor(() =>
      expect(resetFederationEnrollment).toHaveBeenCalledWith({
        pinDisposition: "remember",
      }),
    );
  });

  it("offers keep-or-forget only when the revoked peer has pinned threads", async () => {
    const revokeFederationPeer = vi.fn(async () => ({
      peer: {
        id: "client_one",
        label: "Studio Mac",
        role: "client" as const,
        status: "revoked" as const,
        capabilities: [],
      },
    }));
    const readFederationPinImpact = vi.fn(async () => ({
      pinnedThreadCount: 3,
      tombstonedThreadCount: 0,
      instanceLabels: ["Studio Mac"],
    }));

    render(
      <FederationSettings
        desktopApi={{
          readFederationHealth: vi.fn(async () => ({
            health: {
              enabled: true,
              role: "gateway" as const,
              status: "listening" as const,
              peers: [
                {
                  id: "client_one",
                  label: "Studio Mac",
                  role: "client" as const,
                  status: "connected" as const,
                  capabilities: [],
                  canRevoke: true,
                },
              ],
            },
          })),
          revokeFederationPeer,
          readFederationPinImpact,
        }}
        onClearSecret={vi.fn(async () => true)}
        onReplaceSecret={vi.fn(async () => true)}
        saving={false}
        snapshot={settingsSnapshot()}
        onSettingsChanged={vi.fn()}
        onWriteConfig={vi.fn(async () => true)}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));

    // The operator is told what is at stake and that keeping is reversible.
    expect(
      await screen.findByText(
        /3 pinned threads from Studio Mac will stop showing/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/come back automatically if you re-enroll/),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Revoke and forget threads" }),
    );
    await waitFor(() =>
      expect(revokeFederationPeer).toHaveBeenCalledWith({
        peerId: "client_one",
        pinDisposition: "forget",
      }),
    );
  });

  it("skips the keep-or-forget question when nothing is pinned", async () => {
    const revokeFederationPeer = vi.fn(async () => ({
      peer: {
        id: "client_one",
        label: "Studio Mac",
        role: "client" as const,
        status: "revoked" as const,
        capabilities: [],
      },
    }));
    const readFederationPinImpact = vi.fn(async () => ({
      pinnedThreadCount: 0,
      tombstonedThreadCount: 0,
      instanceLabels: [],
    }));

    render(
      <FederationSettings
        desktopApi={{
          readFederationHealth: vi.fn(async () => ({
            health: {
              enabled: true,
              role: "gateway" as const,
              status: "listening" as const,
              peers: [
                {
                  id: "client_one",
                  label: "Studio Mac",
                  role: "client" as const,
                  status: "connected" as const,
                  capabilities: [],
                  canRevoke: true,
                },
              ],
            },
          })),
          revokeFederationPeer,
          readFederationPinImpact,
        }}
        onClearSecret={vi.fn(async () => true)}
        onReplaceSecret={vi.fn(async () => true)}
        saving={false}
        snapshot={settingsSnapshot()}
        onSettingsChanged={vi.fn()}
        onWriteConfig={vi.fn(async () => true)}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(readFederationPinImpact).toHaveBeenCalled());

    // Nothing pinned means nothing to decide: one plain confirm, no
    // forget-threads button, no scary copy.
    expect(
      await screen.findByRole("button", { name: "Confirm revoke" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Revoke and forget threads" }),
    ).toBeNull();
  });
});

/** Applies a config patch to a snapshot the way the settings writer does. */
function withFederationPatch(
  snapshot: DesktopSettingsSnapshot,
  patch: DesktopSettingsConfigPatch,
): DesktopSettingsSnapshot {
  const federation: Record<string, unknown> = { ...snapshot.federation };
  for (const [key, value] of Object.entries(patch.federation ?? {})) {
    if (value === undefined) continue;
    federation[key] = { value, source: "config" };
  }
  return { ...snapshot, federation } as unknown as DesktopSettingsSnapshot;
}

function federationHealthApi(): DesktopApi {
  return {
    readFederationHealth: vi.fn(async () => ({
      health: {
        enabled: true,
        role: "gateway" as const,
        status: "listening" as const,
        peers: [],
      },
    })),
  } as DesktopApi;
}

function settingsSnapshot(): DesktopSettingsSnapshot {
  return {
    federation: {
      mode: { value: "gateway", source: "config" },
      instanceLabel: { value: "", source: "default" },
      instanceNotes: { value: "", source: "default" },
      listenHost: { value: "127.0.0.1", source: "config" },
      listenPort: { value: 8765, source: "config" },
      compressionEnabled: { value: true, source: "default" },
      publicUrl: {
        value: "wss://pwragent.example.com/federation",
        source: "config",
      },
      gatewayUrl: {
        value: "wss://client.example.com/federation",
        source: "config",
      },
      gatewayEndpoints: {
        value: ["wss://client.example.com/federation"],
        source: "config",
      },
      advertisedEndpoints: { value: [], source: "default" },
      cloudflareEndpoint: { value: "", source: "default" },
      cloudflareMtlsEnabled: { value: true, source: "config" },
      cloudflareAccessServiceAuthEnabled: { value: false, source: "config" },
      cloudflareAccessOAuthEnabled: { value: false, source: "config" },
      instancePrivateKey: {
        configured: true,
        source: "keychain",
        writable: true,
      },
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
  } as unknown as DesktopSettingsSnapshot;
}
