import type { FederationHealthStatus } from "@pwragent/shared";
import { formatFederationPeerDisplayLabel } from "@pwragent/shared";

/** Only authenticated local transports belong here, not relayed directory peers. */
export function FederationConnections({ health }: { health: FederationHealthStatus }) {
  const connections = health.enabled && !health.leaseHolder ? health.activeConnections ?? [] : [];
  return <div className="federation-connections">
    <strong>Active connections</strong>
    {connections.length === 0 ? <p>Not connected</p> : <ul aria-label="Active federation connections">
      {connections.map((connection) => {
        const peer = health.peers.find((candidate) => candidate.id === connection.peerId);
        return <li key={`${connection.direction}:${connection.peerId}`}>
          <span>{peer ? formatFederationPeerDisplayLabel(peer, health.peers) : connection.peerId}</span>
          {connection.direction === "outgoing" ? <p>Outgoing · <code>{connection.endpoint ?? "Endpoint unavailable"}</code></p>
            : <>
              <p>Incoming · Remote socket: <code>{connection.remoteAddress ?? "Unavailable"}</code></p>
              <p>Local socket: <code>{connection.localAddress ?? "Unavailable"}</code></p>
            </>}
        </li>;
      })}
    </ul>}
    {connections.some((connection) => connection.direction === "incoming")
      ? <p>Socket addresses show this hop; incoming tunnels or proxies may appear as the remote.</p> : null}
  </div>;
}
