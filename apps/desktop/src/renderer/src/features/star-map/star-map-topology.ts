import type { FederationInstanceRole, FederationPeerSummary } from "@pwragent/shared";

export type StarMapTopologyNode = {
  instanceId: string;
  /** Undefined for the root of the federation as this viewer can see it. */
  parentId?: string;
  /** 0 for the root, 1 for its clients, and so on. */
  depth: number;
  isLocal: boolean;
  role: FederationInstanceRole;
};

/**
 * The federation as a tree, rooted at the gateway this viewer reaches.
 *
 * What is derivable today: our own parent (the enrolled gateway) and the
 * gateway's client list. `FederationPeerSummary` carries no per-peer
 * parent id, so a peer that is itself a gateway for further clients
 * cannot be nested yet — those clients simply are not visible to us. The
 * shape is a general tree so that when the protocol advertises a parent,
 * deeper levels place without touching the layout maths.
 */
export function buildFederationTopology(params: {
  localInstanceId: string;
  localRole: FederationInstanceRole;
  peers: readonly FederationPeerSummary[];
  /** Gateway this instance is enrolled with, when it is a client. */
  gatewayInstanceId?: string;
}): StarMapTopologyNode[] {
  const peerById = new Map(params.peers.map((peer) => [peer.id, peer]));
  const gatewayId =
    params.gatewayInstanceId && peerById.has(params.gatewayInstanceId)
      ? params.gatewayInstanceId
      : params.peers.find((peer) => peer.role === "gateway")?.id;

  // A client hangs off its gateway; anything else roots at the local body.
  const rootId =
    params.localRole === "client" && gatewayId
      ? gatewayId
      : params.localInstanceId;

  const nodes: StarMapTopologyNode[] = [
    {
      instanceId: rootId,
      depth: 0,
      isLocal: rootId === params.localInstanceId,
      role: rootId === params.localInstanceId ? params.localRole : "gateway",
    },
  ];
  if (rootId !== params.localInstanceId) {
    nodes.push({
      instanceId: params.localInstanceId,
      parentId: rootId,
      depth: 1,
      isLocal: true,
      role: params.localRole,
    });
  }
  for (const peer of params.peers) {
    if (peer.id === rootId) continue;
    nodes.push({
      instanceId: peer.id,
      parentId: rootId,
      depth: 1,
      isLocal: false,
      role: peer.role,
    });
  }
  return nodes;
}

export function topologyEdges(
  nodes: readonly StarMapTopologyNode[],
): { fromInstanceId: string; toInstanceId: string }[] {
  return nodes
    .filter((node) => node.parentId)
    .map((node) => ({
      fromInstanceId: node.parentId!,
      toInstanceId: node.instanceId,
    }));
}
