import fc from "fast-check";
import { expect, it } from "vitest";
import {
  effectiveFederationMemberRole,
  federationAssignedRoleMismatch,
  type FederationPeerRole,
} from "../contracts/federation";

// Rule: a member is contained when its own setting or its upstream gateway
// says so, and by nothing else. Neither source can relax the other. A peer's
// assignment that differs from what the member enforces is a mismatch:
// `refused` when the peer contains a member that acts as full, `wider` when
// the peer would allow more than the member allows itself.

const role = fc.constantFrom<FederationPeerRole>("full", "contained");
const strictness = (value: FederationPeerRole) => value === "contained" ? 1 : 0;

it("contains a member exactly when its setting or its gateway contains it", () => {
  fc.assert(fc.property(role, fc.option(role, { nil: undefined }), (configured, gateway) => {
    const effective = effectiveFederationMemberRole(configured, gateway);
    expect(effective === "contained").toBe(configured === "contained" || gateway === "contained");
    // Neither source relaxes the member below the other.
    expect(strictness(effective)).toBeGreaterThanOrEqual(strictness(configured));
    if (gateway) expect(strictness(effective)).toBeGreaterThanOrEqual(strictness(gateway));
  }));
});

it("names a mismatch exactly when a peer's assignment differs from what the member enforces", () => {
  fc.assert(fc.property(role, fc.option(role, { nil: undefined }), (effective, assigned) => {
    const mismatch = federationAssignedRoleMismatch(effective, assigned);
    if (assigned === undefined || assigned === effective) {
      expect(mismatch).toBeUndefined();
    } else {
      expect(mismatch).toBe(assigned === "contained" ? "refused" : "wider");
    }
  }));
});

it("never reports a mismatch with the gateway that contains the member", () => {
  // The member follows its gateway, so the gateway's own assignment can
  // only disagree when it would allow more than the member's own setting.
  fc.assert(fc.property(role, role, (configured, gateway) => {
    const mismatch = federationAssignedRoleMismatch(effectiveFederationMemberRole(configured, gateway), gateway);
    expect(mismatch === undefined || mismatch === "wider").toBe(true);
    expect(mismatch === "wider").toBe(configured === "contained" && gateway === "full");
  }));
});
