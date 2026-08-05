import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { useCelestialIcons } from "../useCelestialIcons";

function buildDesktopApi(): {
  desktopApi: DesktopApi;
  emit: (event: AgentEvent) => void;
} {
  let listener: ((event: AgentEvent) => void) | undefined;
  const desktopApi: DesktopApi = {
    readFederationHealth: vi.fn(async () => ({
      health: {
        enabled: true,
        role: "gateway" as const,
        status: "listening" as const,
        instanceId: "pwr_local",
        localCelestialIcon: "sun" as const,
        peers: [
          {
            id: "peer_one",
            label: "Mac-Mini-M4",
            role: "client" as const,
            status: "connected" as const,
            capabilities: [],
            celestialIcon: "moon" as const,
          },
        ],
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

describe("useCelestialIcons", () => {
  it("seeds local and peer icons from federation health", async () => {
    const { desktopApi } = buildDesktopApi();
    const { result } = renderHook(() => useCelestialIcons({ desktopApi }));

    await waitFor(() => {
      expect(result.current.localIcon).toBe("sun");
    });
    expect(result.current.iconFor("peer_one")).toBe("moon");
    expect(result.current.iconFor(undefined)).toBe("sun");
    expect(result.current.iconFor("pwr_local")).toBe("sun");
    expect(result.current.iconFor("unknown_peer")).toBeUndefined();
  });

  it("follows celestialIcons/changed events, including the local icon", async () => {
    const { desktopApi, emit } = buildDesktopApi();
    const { result } = renderHook(() => useCelestialIcons({ desktopApi }));
    await waitFor(() => {
      expect(result.current.localIcon).toBe("sun");
    });

    act(() => {
      emit({
        backend: "codex",
        notification: {
          method: "federation/celestialIcons/changed",
          params: {
            assignments: [
              {
                instanceId: "pwr_local",
                icon: "black-hole",
                source: "override",
                updatedAt: 10,
              },
              {
                instanceId: "peer_one",
                icon: "ringed-planet",
                source: "auto",
                updatedAt: 10,
              },
            ],
          },
        },
      });
    });

    await waitFor(() => {
      expect(result.current.iconFor("peer_one")).toBe("ringed-planet");
    });
    expect(result.current.localIcon).toBe("black-hole");
    expect(result.current.iconFor(undefined)).toBe("black-hole");
  });
});
