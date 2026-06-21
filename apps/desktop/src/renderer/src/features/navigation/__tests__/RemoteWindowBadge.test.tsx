import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FederationHealthStatus,
  FederationPeerSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { RemoteWindowBadge } from "../RemoteWindowBadge";

type TestWindow = typeof window & {
  __pwragentFederationTarget?: { scope: "remote"; instanceId: string };
  pwragent?: DesktopApi;
};

function setRemoteTarget(instanceId: string | undefined): void {
  const testWindow = window as TestWindow;
  if (instanceId === undefined) {
    delete testWindow.__pwragentFederationTarget;
    return;
  }
  testWindow.__pwragentFederationTarget = { scope: "remote", instanceId };
}

function setDesktopApi(api: DesktopApi | undefined): void {
  (window as TestWindow).pwragent = api;
}

function healthWithPeer(peer: FederationPeerSummary): FederationHealthStatus {
  return {
    enabled: true,
    role: "gateway",
    status: "listening",
    peers: [peer],
  };
}

afterEach(() => {
  cleanup();
  setRemoteTarget(undefined);
  setDesktopApi(undefined);
});

describe("RemoteWindowBadge", () => {
  it("renders nothing in a local window (no federation target)", () => {
    setRemoteTarget(undefined);
    setDesktopApi({ readFederationHealth: vi.fn() });

    const { container } = render(<RemoteWindowBadge />);

    expect(container).toBeEmptyDOMElement();
  });

  it("shows the peer label and a connected status dot for a healthy peer", async () => {
    setRemoteTarget("client_studio_mac_01");
    setDesktopApi({
      readFederationHealth: vi.fn(async () => ({
        health: healthWithPeer({
          id: "client_studio_mac_01",
          label: "Studio Mac",
          role: "client",
          status: "connected",
          capabilities: ["thread_navigation"],
        }),
      })),
    });

    render(<RemoteWindowBadge />);

    expect(await screen.findByText("Studio Mac")).toBeInTheDocument();
    expect(screen.getByText("Remote")).toBeInTheDocument();
    const dot = document.querySelector(".remote-window-badge__dot");
    await waitFor(() =>
      expect(dot).toHaveClass("remote-window-badge__dot--connected"),
    );
  });

  it("falls back to a down dot and short id when the peer is absent from health", async () => {
    setRemoteTarget("client_absent_peer_0123456789");
    setDesktopApi({
      readFederationHealth: vi.fn(async () => ({
        health: healthWithPeer({
          id: "some_other_peer",
          label: "Other",
          role: "client",
          status: "connected",
          capabilities: [],
        }),
      })),
    });

    render(<RemoteWindowBadge />);

    // Short id fallback is the first 8 chars of the instance id.
    expect(await screen.findByText("client_a")).toBeInTheDocument();
    const dot = document.querySelector(".remote-window-badge__dot");
    await waitFor(() =>
      expect(dot).toHaveClass("remote-window-badge__dot--down"),
    );
  });

  it("falls back to a down dot when health diagnostics throw", async () => {
    setRemoteTarget("client_unreachable_abcdef");
    setDesktopApi({
      readFederationHealth: vi.fn(async () => {
        throw new Error("federation unavailable");
      }),
    });

    render(<RemoteWindowBadge />);

    const dot = await waitFor(() => {
      const node = document.querySelector(".remote-window-badge__dot");
      expect(node).toHaveClass("remote-window-badge__dot--down");
      return node;
    });
    expect(dot).toBeInTheDocument();
  });
});
