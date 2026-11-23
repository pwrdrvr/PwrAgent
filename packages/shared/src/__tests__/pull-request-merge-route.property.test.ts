import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  FEDERATION_CAPABILITIES,
  type FederationCapability,
  type FederationConnectionState,
  type FederationTarget,
} from "../contracts/federation";
import { THREAD_PULL_REQUEST_MERGE_CAPABILITY } from "../contracts/navigation";
import { resolvePullRequestMergeRoute, type PullRequestMergeRoute } from "../pull-request-merge-offer";

/**
 * Where a PR card's merge runs. A peer's thread, in this instance's window
 * or a viewer window, merges on its owner when that owner answers the merge
 * request and grants turn control, and only while it is reachable. This
 * instance's own thread merges here, except in a viewer window, whose rows
 * all name their owner. Every other case offers no merge.
 */
const STATUSES: (FederationConnectionState | undefined)[] = [
  undefined, "disabled", "listening", "connecting", "handshaking", "connected", "degraded", "rejected", "revoked",
  "disconnected",
];

const remoteTarget = fc.constantFrom("peer-a", "peer-b").map((instanceId): FederationTarget =>
  ({ scope: "remote", instanceId }));
const anyTarget = fc.oneof(remoteTarget, fc.constant<FederationTarget>({ scope: "local" }));
const capabilities = fc.subarray([...FEDERATION_CAPABILITIES] as FederationCapability[]);
const federation = fc.record({
  ref: fc.record({ target: anyTarget }),
  peerStatus: fc.constantFrom(...STATUSES),
  capabilities: fc.option(capabilities, { nil: undefined }),
}).map(({ ref, peerStatus, capabilities }) => ({
  ref,
  ...(peerStatus === undefined ? {} : { peerStatus }),
  ...(capabilities === undefined ? {} : { capabilities }),
}));

/** The rule, stated case by case. */
function oracle(input: {
  federation?: { ref: { target: FederationTarget }; peerStatus?: string; capabilities?: readonly string[] };
  viewerWindow: boolean;
}): PullRequestMergeRoute {
  const target = input.federation?.ref.target;
  if (target?.scope === "remote") {
    const granted = input.federation!.capabilities ?? [];
    const reachable = input.federation!.peerStatus === undefined || input.federation!.peerStatus === "connected";
    const answers = granted.includes(THREAD_PULL_REQUEST_MERGE_CAPABILITY) && granted.includes("turn_control");
    return reachable && answers ? { kind: "owner", target } : { kind: "none" };
  }
  return input.viewerWindow ? { kind: "none" } : { kind: "local" };
}

describe("resolvePullRequestMergeRoute", () => {
  it("routes every thread as the rule says", () => {
    fc.assert(fc.property(fc.option(federation, { nil: undefined }), fc.boolean(), (row, viewerWindow) => {
      const input = { ...(row ? { federation: row } : {}), viewerWindow };
      expect(resolvePullRequestMergeRoute(input)).toEqual(oracle(input));
    }), { numRuns: 2000 });
  });

  it("sends a capable, connected peer's merge to that peer, in either window", () => {
    fc.assert(fc.property(remoteTarget, fc.boolean(), (target, viewerWindow) => {
      expect(resolvePullRequestMergeRoute({
        federation: {
          ref: { target },
          peerStatus: "connected",
          capabilities: [THREAD_PULL_REQUEST_MERGE_CAPABILITY, "turn_control"],
        },
        viewerWindow,
      })).toEqual({ kind: "owner", target });
    }));
  });

  it("never merges a peer's thread here", () => {
    fc.assert(fc.property(federation, fc.boolean(), (row, viewerWindow) => {
      fc.pre(row.ref.target.scope === "remote");
      expect(resolvePullRequestMergeRoute({ federation: row, viewerWindow }).kind).not.toBe("local");
    }));
  });

  it("offers an older owner, or one that withholds turn control, no merge", () => {
    fc.assert(fc.property(remoteTarget, capabilities, fc.boolean(), (target, granted, viewerWindow) => {
      fc.pre(!granted.includes(THREAD_PULL_REQUEST_MERGE_CAPABILITY) || !granted.includes("turn_control"));
      expect(resolvePullRequestMergeRoute({
        federation: { ref: { target }, peerStatus: "connected", capabilities: granted },
        viewerWindow,
      })).toEqual({ kind: "none" });
    }));
  });
});
