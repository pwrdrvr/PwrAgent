import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { useFederationPeerConnectivity } from "../useFederationPeerConnectivity";

function buildDesktopApi(params: {
  seededStatus?: "connected" | "disconnected";
}): {
  desktopApi: DesktopApi;
  emit: (event: AgentEvent) => void;
} {
  let listener: ((event: AgentEvent) => void) | undefined;
  const desktopApi: DesktopApi = {
    readFederationHealth: vi.fn(async () => ({
      health: {
        enabled: true,
        role: "client" as const,
        status: "connected" as const,
        peers: params.seededStatus
          ? [
              {
                id: "peer_one",
                label: "Mac-Mini-M4",
                role: "gateway" as const,
                status: params.seededStatus,
                capabilities: [],
              },
            ]
          : [],
      },
    })),
    onAgentEvent: vi.fn((callback: (event: AgentEvent) => void) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    }),
  };
  return {
    desktopApi,
    emit: (event) => listener?.(event),
  };
}

function peerStatusEvent(
  instanceId: string,
  status: string,
  unavailableReason?: string,
): AgentEvent {
  return {
    backend: "codex",
    federationTarget: { scope: "remote", instanceId },
    notification: {
      method: "federation/peerStatus/changed",
      params: { instanceId, status, ...(unavailableReason ? { unavailableReason } : {}) },
    },
  } as AgentEvent;
}

describe("useFederationPeerConnectivity", () => {
  it("stays connected without a target (local windows)", () => {
    const { desktopApi } = buildDesktopApi({});
    const { result } = renderHook(() =>
      useFederationPeerConnectivity({ desktopApi }),
    );
    expect(result.current.connected).toBe(true);
    expect(desktopApi.readFederationHealth).not.toHaveBeenCalled();
  });

  it("seeds from health and follows peerStatus transitions", async () => {
    const { desktopApi, emit } = buildDesktopApi({
      seededStatus: "disconnected",
    });
    const { result } = renderHook(() =>
      useFederationPeerConnectivity({
        desktopApi,
        target: { scope: "remote", instanceId: "peer_one" },
      }),
    );

    // Before the health read resolves the hook reports connected so
    // surfaces don't flash a disconnected state during boot.
    expect(result.current.connected).toBe(true);
    await waitFor(() => {
      expect(result.current.connected).toBe(false);
    });
    expect(result.current.status).toBe("disconnected");

    act(() => {
      emit(peerStatusEvent("peer_one", "connected"));
    });
    expect(result.current.connected).toBe(true);

    act(() => {
      emit(peerStatusEvent("peer_one", "disconnected", "Peer went away."));
    });
    expect(result.current.connected).toBe(false);
    expect(result.current.unavailableReason).toBe("Peer went away.");
  });

  it("ignores status events for other peers", async () => {
    const { desktopApi, emit } = buildDesktopApi({ seededStatus: "connected" });
    const { result } = renderHook(() =>
      useFederationPeerConnectivity({
        desktopApi,
        target: { scope: "remote", instanceId: "peer_one" },
      }),
    );
    await waitFor(() => {
      expect(result.current.status).toBe("connected");
    });

    act(() => {
      emit(peerStatusEvent("peer_other", "disconnected"));
    });
    expect(result.current.connected).toBe(true);
  });
});
