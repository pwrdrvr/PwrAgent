import fc from "fast-check";
import { afterEach, expect, it } from "vitest";
import {
  isRemoteFederationTarget,
  type FederationTarget,
} from "@pwragent/shared/contracts/federation";
import { readRendererFederationTarget } from "../federation-window";
import { remoteApplicationInstanceIdFor } from "../useDesktopApplications";

type WindowWithTarget = typeof window & { __pwragentFederationTarget?: unknown };

afterEach(() => {
  delete (window as WindowWithTarget).__pwragentFederationTarget;
});

/** The chain the window shell used before the helper: the oracle. */
function oracle(
  thread: FederationTarget | undefined,
  launchpad: FederationTarget | undefined,
  navigation: FederationTarget | undefined,
): string | undefined {
  return thread && isRemoteFederationTarget(thread)
    ? thread.instanceId
    : launchpad && isRemoteFederationTarget(launchpad)
      ? launchpad.instanceId
      : navigation && isRemoteFederationTarget(navigation)
        ? navigation.instanceId
        : readRendererFederationTarget()?.instanceId;
}

const target = fc.option(fc.oneof(
  fc.constant({ scope: "local" } as FederationTarget),
  fc.constantFrom("peer-a", "peer-b", "peer-c")
    .map((instanceId) => ({ scope: "remote", instanceId }) as FederationTarget),
), { nil: undefined });

// Rule: the first remote target, most specific first, else the window's owner.
it("picks the same machine as the shell's original chain", () => {
  fc.assert(fc.property(target, target, target, fc.option(fc.constant("peer-window"), { nil: undefined }),
    (thread, launchpad, navigation, windowOwner) => {
      if (windowOwner) {
        (window as WindowWithTarget).__pwragentFederationTarget = { scope: "remote", instanceId: windowOwner };
      } else {
        delete (window as WindowWithTarget).__pwragentFederationTarget;
      }
      expect(remoteApplicationInstanceIdFor([thread, launchpad, navigation]))
        .toBe(oracle(thread, launchpad, navigation));
    }));
});
