import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import type { FederationConnectionState } from "@pwragent/shared";
import { useDesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";

// A remote window targets another PwrAgent instance over federation. The
// federation target injected into the window carries only an instanceId, so we
// poll federation health to resolve the peer's human label and live connection
// state. Health is snapshot-on-read with no push channel, so a light poll is
// the pragmatic way to keep the badge fresh.
const POLL_INTERVAL_MS = 8000;

type RemotePeerState = {
  label: string;
  status: FederationConnectionState;
};

function dotModifier(
  status: FederationConnectionState,
): "connected" | "pending" | "down" {
  switch (status) {
    case "connected":
      return "connected";
    case "connecting":
    case "handshaking":
    case "listening":
    case "degraded":
      return "pending";
    default:
      return "down";
  }
}

function statusLabel(status: FederationConnectionState): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "connecting":
    case "handshaking":
      return "Connecting";
    case "degraded":
      return "Degraded";
    case "listening":
      return "Listening";
    case "rejected":
      return "Rejected";
    case "revoked":
      return "Revoked";
    default:
      return "Offline";
  }
}

export function RemoteWindowBadge(): ReactElement | null {
  const desktopApi = useDesktopApi();
  const target = readRendererFederationTarget();
  const instanceId = target?.instanceId;
  const [peer, setPeer] = useState<RemotePeerState | undefined>(undefined);

  useEffect(() => {
    if (!instanceId) {
      setPeer(undefined);
      return;
    }
    const shortId = instanceId.slice(0, 8);
    const read = desktopApi?.readFederationHealth;
    let cancelled = false;

    async function poll(): Promise<void> {
      if (!read) {
        if (!cancelled) setPeer({ label: shortId, status: "disconnected" });
        return;
      }
      try {
        const { health } = await read();
        if (cancelled) return;
        const match = health.peers.find(
          (candidate) => candidate.id === instanceId,
        );
        setPeer(
          match
            ? { label: match.label || shortId, status: match.status }
            : { label: shortId, status: "disconnected" },
        );
      } catch {
        if (!cancelled) setPeer({ label: shortId, status: "disconnected" });
      }
    }

    void poll();
    const timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [desktopApi, instanceId]);

  if (!instanceId) return null;

  const status = peer?.status ?? "connecting";
  const label = peer?.label ?? instanceId.slice(0, 8);

  return (
    <span
      className="remote-window-badge"
      title={`Remote instance · ${statusLabel(status)}`}
      aria-label={`Remote instance ${label}, ${statusLabel(status)}`}
    >
      <span
        className={`remote-window-badge__dot remote-window-badge__dot--${dotModifier(status)}`}
        aria-hidden
      />
      <span className="remote-window-badge__kind">Remote</span>
      <span className="remote-window-badge__label">{label}</span>
    </span>
  );
}
