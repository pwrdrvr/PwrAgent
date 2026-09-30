import type { FederationHealthStatus } from "@pwragent/shared";
import { formatFederationPeerDisplayLabel } from "@pwragent/shared";

/**
 * Only authenticated local transports belong here, not relayed directory peers.
 * `collapsible` folds the socket list behind a one-line summary so it cannot
 * push the Federation Activity charts below the fold.
 */
export function FederationConnections({ health, collapsible = false }: {
  health: FederationHealthStatus;
  collapsible?: boolean;
}) {
  const connections = health.enabled && !health.leaseHolder ? health.activeConnections ?? [] : [];
  const list = connections.length === 0 ? null : <ul aria-label="Active federation connections">
    {connections.map((connection) => {
      const peer = health.peers.find((candidate) => candidate.id === connection.peerId);
      return <li key={`${connection.direction}:${connection.peerId}`}>
        <span>{peer ? formatFederationPeerDisplayLabel(peer, health.peers) : connection.peerId}</span>
        {connection.direction === "outgoing" ? <p>Outgoing · <code>{connection.endpoint ?? "Endpoint unavailable"}</code></p>
          : connection.via === "cloudflare-tunnel" ? <>
            {/* The remote socket is this computer's own cloudflared, which read as a local peer. */}
            <p>Incoming · via Cloudflare Tunnel{connection.reportedClientAddress
              ? <> · client <code>{connection.reportedClientAddress}</code> (reported by Cloudflare)</> : null}</p>
            <p>Local socket: <code>{connection.localAddress ?? "Unavailable"}</code></p>
          </> : <>
            <p>Incoming · Remote socket: <code>{connection.remoteAddress ?? "Unavailable"}</code></p>
            <p>Local socket: <code>{connection.localAddress ?? "Unavailable"}</code></p>
          </>}
      </li>;
    })}
  </ul>;
  const proxyNote = connections.some((connection) => connection.direction === "incoming" && !connection.via)
    ? <p>Socket addresses show this hop; incoming tunnels or proxies may appear as the remote.</p> : null;
  if (collapsible) {
    return <details className="federation-connections federation-connections--collapsible">
      <summary><strong>Active connections</strong>{" · "}
        {connections.length === 0 ? <span>Not connected</span> : <span>{connections.length}</span>}</summary>
      {list}
      {proxyNote}
    </details>;
  }
  return <div className="federation-connections">
    <strong>Active connections</strong>
    {list ?? <p>Not connected</p>}
    {proxyNote}
  </div>;
}
