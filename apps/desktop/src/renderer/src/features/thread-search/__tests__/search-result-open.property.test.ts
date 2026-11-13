import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildThreadIdentityKey,
  federatedThreadIdentityKey,
  type AppServerBackendKind,
  type FederationRemoteTarget,
  type FederationTarget,
} from "@pwragent/shared";
import { planSearchResultOpen } from "../search-result-open";

// The rules a click on a search result keeps:
// - the main window never opens another window: every result, a peer's
//   included, is shown in place, and a peer's thread carries its owner;
// - a remote viewer hands a peer's result to the owner's window and shows
//   its own results in place;
// - the find bar's deep link names the thread that is shown, by the key the
//   window selects it under (oracle: the shared identity-key builders).

const backend = fc.constantFrom<AppServerBackendKind>("codex", "claude", "acp:grok");
const threadId = fc.stringMatching(/^[a-z0-9-]{1,12}$/);
const remoteTarget: fc.Arbitrary<FederationRemoteTarget> = fc
  .stringMatching(/^[a-z0-9_]{1,10}$/)
  .map((instanceId) => ({ scope: "remote", instanceId }));
const target: fc.Arbitrary<FederationTarget> = fc.oneof(
  remoteTarget,
  fc.constant({ scope: "local" as const }),
);
const result = fc.record({
  backend,
  threadId,
  federation: fc.option(
    fc.record({ ref: fc.record({ backend, target, threadId }), instanceLabel: fc.string() }),
    { nil: undefined },
  ),
});

describe("planSearchResultOpen", () => {
  it("shows every result in the main window, with a peer's owner", () => {
    fc.assert(fc.property(result, (opened) => {
      const plan = planSearchResultOpen(opened, undefined);
      expect(plan.kind).toBe("this-window");
      if (plan.kind !== "this-window") return;
      const ref = opened.federation?.ref;
      if (ref?.target.scope === "remote") {
        expect(plan.federationTarget).toEqual(ref.target);
        expect([plan.backend, plan.threadId]).toEqual([ref.backend, ref.threadId]);
      } else {
        expect(plan.federationTarget).toBeUndefined();
        expect([plan.backend, plan.threadId]).toEqual([opened.backend, opened.threadId]);
      }
    }));
  });

  it("sends a peer's result to its owner's window from a remote viewer", () => {
    fc.assert(fc.property(result, remoteTarget, (opened, windowTarget) => {
      const plan = planSearchResultOpen(opened, windowTarget);
      const ref = opened.federation?.ref;
      if (ref?.target.scope === "remote") {
        expect(plan).toEqual({ kind: "owner-window", target: ref.target, initialThread: ref });
      } else {
        expect(plan).toMatchObject({ kind: "this-window", threadId: opened.threadId });
        expect(plan).not.toHaveProperty("federationTarget");
      }
    }));
  });

  it("deep-links the find bar to the thread it shows", () => {
    fc.assert(fc.property(result, fc.option(remoteTarget, { nil: undefined }), (opened, windowTarget) => {
      const plan = planSearchResultOpen(opened, windowTarget);
      if (plan.kind !== "this-window") return;
      expect(plan.threadKey).toBe(plan.federationTarget
        ? federatedThreadIdentityKey({
            backend: plan.backend,
            target: plan.federationTarget,
            threadId: plan.threadId,
          })
        : buildThreadIdentityKey(plan.backend, plan.threadId));
    }));
  });
});
