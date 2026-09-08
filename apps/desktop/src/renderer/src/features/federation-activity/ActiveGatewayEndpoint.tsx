import type { FederationHealthStatus } from "@pwragent/shared";

/** Show the authenticated connection, never infer it from configured order. */
export function ActiveGatewayEndpoint({ health }: { health: FederationHealthStatus }) {
  if (health.role === "gateway") return null;
  const endpoint = health.enabled && !health.leaseHolder
    ? health.gatewayEndpoints?.find((candidate) => candidate.state === "active")
    : undefined;
  return <p style={{ overflowWrap: "anywhere" }}>
    Active gateway: {endpoint ? <code>{endpoint.url}</code> : "Not connected"}
  </p>;
}
