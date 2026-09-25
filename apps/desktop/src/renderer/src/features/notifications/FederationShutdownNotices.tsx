import { useEffect, useRef, useState } from "react";
import {
  FEDERATION_SHUTDOWN_CHANGED_METHOD,
  type FederationPeerShutdown,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

export function buildFederationShutdownNotice(peer: FederationPeerShutdown, now: number): AppNoticeToastNotice {
  const seconds = peer.deadlineAt === null ? null : Math.max(0, Math.ceil((peer.deadlineAt - now) / 1000));
  return {
    id: `federation-shutdown:${peer.instanceId}`,
    title: `${peer.label} is shutting down`,
    message: peer.state === "exiting" || seconds === 0
      ? "Remote access through this instance is disconnecting."
      : seconds === null
        ? "Automatic quit is paused. New remote requests are on hold."
        : `Remote access through this instance will disconnect in ${seconds} second${seconds === 1 ? "" : "s"}.`,
    detail: "Work on other machines may continue. New requests resume when shutdown is cancelled or the instance reconnects.",
    autoDismiss: false,
    tone: "warning",
  };
}

export function FederationShutdownNotices(props: {
  desktopApi?: Pick<DesktopApi, "onAgentEvent" | "readFederationHealth">;
  onNoticeChanged: (instanceId: string, notice: AppNoticeToastNotice | undefined) => void;
}) {
  const { onNoticeChanged } = props;
  const [peers, setPeers] = useState<FederationPeerShutdown[]>([]);
  const [now, setNow] = useState(Date.now);
  const dismissed = useRef(new Map<string, string>());
  const published = useRef(new Map<string, string>());
  useEffect(() => {
    let disposed = false;
    let receivedEvent = false;
    const unsubscribe = props.desktopApi?.onAgentEvent?.((event) => {
      if (event.federationTarget || event.notification.method !== FEDERATION_SHUTDOWN_CHANGED_METHOD) return;
      receivedEvent = true;
      setPeers((event.notification.params as { notices: FederationPeerShutdown[] }).notices);
      setNow(Date.now());
    });
    void props.desktopApi?.readFederationHealth?.({}).then(({ health }) => {
      if (!disposed && !receivedEvent) setPeers(health.shutdownNotices ?? []);
    }).catch(() => {});
    return () => { disposed = true; unsubscribe?.(); };
  }, [props.desktopApi]);
  useEffect(() => {
    if (!peers.some((peer) => peer.deadlineAt !== null && peer.deadlineAt > Date.now())) return;
    const timer = setInterval(() => {
      const tick = Date.now();
      setNow(tick);
      if (!peers.some((peer) => peer.deadlineAt !== null && peer.deadlineAt > tick)) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [peers]);
  useEffect(() => {
    const next = new Map<string, string>();
    for (const peer of peers) {
      if (dismissed.current.get(peer.instanceId) === peer.shutdownId) continue;
      const notice = buildFederationShutdownNotice(peer, now);
      notice.onDismiss = () => {
        dismissed.current.set(peer.instanceId, peer.shutdownId);
        onNoticeChanged(peer.instanceId, undefined);
      };
      const signature = JSON.stringify(notice);
      next.set(peer.instanceId, signature);
      if (published.current.get(peer.instanceId) !== signature) onNoticeChanged(peer.instanceId, notice);
    }
    for (const id of published.current.keys()) {
      if (!next.has(id)) onNoticeChanged(id, undefined);
    }
    published.current = next;
  }, [peers, now, onNoticeChanged]);
  return null;
}
