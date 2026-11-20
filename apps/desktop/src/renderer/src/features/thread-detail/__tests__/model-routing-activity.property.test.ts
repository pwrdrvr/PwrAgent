import fc from "fast-check";
import { expect, it } from "vitest";
import {
  isModelRoutingActivityEntry,
  mergeModelRoutingActivityEntry,
  modelRoutingActivityEntryId,
  type ModelRoutingNotification,
} from "../model-routing-activity";

const model = fc.constantFrom("gpt-6.2-sol", "gpt-6-luna", "gpt-6-mini");
const notificationArb: fc.Arbitrary<ModelRoutingNotification> = fc.oneof(
  fc.record({
    method: fc.constant("turn/modelRerouted" as const),
    params: fc.record({
      turnId: fc.constant("turn-1"),
      fromModel: model,
      toModel: model,
      reason: fc.constantFrom("highRiskCyberActivity", "aFutureReason"),
    }),
  }),
  fc.record({
    method: fc.constant("turn/verificationRequested" as const),
    params: fc.record({
      turnId: fc.constant("turn-1"),
      verifications: fc.array(fc.constantFrom("trustedAccessForCyber", "aFutureCheck"), {
        minLength: 1,
        maxLength: 3,
      }),
    }),
  }),
);

it("keeps one row per distinct reroute and verification, whatever order they arrive in", () => {
  fc.assert(fc.property(fc.array(notificationArb, { minLength: 1, maxLength: 8 }), (notifications) => {
    let entry = undefined as ReturnType<typeof mergeModelRoutingActivityEntry>;
    for (const notification of notifications) {
      entry = mergeModelRoutingActivityEntry(entry, notification, 1_000);
    }
    // Oracle: the set of distinct notices received.
    const expected = new Set<string>();
    for (const notification of notifications) {
      if (notification.method === "turn/modelRerouted") {
        expected.add(`reroute:${notification.params.fromModel}:${notification.params.toModel}`);
      } else {
        for (const verification of notification.params.verifications) {
          expected.add(`verification:${verification}`);
        }
      }
    }
    expect(entry?.id).toBe(modelRoutingActivityEntryId("turn-1"));
    expect(entry && isModelRoutingActivityEntry(entry)).toBe(true);
    expect(new Set(entry?.details.map((detail) => detail.id))).toEqual(expected);
    expect(entry?.details).toHaveLength(expected.size);
    expect(entry?.createdAt).toBe(1_000);
  }));
});

it("says which model answered and what verification was asked for", () => {
  const rerouted = mergeModelRoutingActivityEntry(undefined, {
    method: "turn/modelRerouted",
    params: {
      turnId: "turn-1",
      fromModel: "gpt-6.2-sol",
      toModel: "gpt-6-luna",
      reason: "highRiskCyberActivity",
    },
  });
  expect(rerouted?.summary).toBe(
    "Rerouted from gpt-6.2-sol to gpt-6-luna because of possible high-risk cybersecurity activity",
  );
  const both = mergeModelRoutingActivityEntry(rerouted, {
    method: "turn/verificationRequested",
    params: { turnId: "turn-1", verifications: ["trustedAccessForCyber"] },
  });
  expect(both?.summary).toBe("Model routing updates (2)");
  expect(both?.details.map((detail) => detail.label)).toEqual([
    "Rerouted from gpt-6.2-sol to gpt-6-luna because of possible high-risk cybersecurity activity",
    "Verification requested: Trusted Access for Cyber",
  ]);
});

it("starts a new row for another turn instead of merging into a stale one", () => {
  const first = mergeModelRoutingActivityEntry(undefined, {
    method: "turn/verificationRequested",
    params: { turnId: "turn-1", verifications: ["trustedAccessForCyber"] },
  }, 1);
  const second = mergeModelRoutingActivityEntry(first, {
    method: "turn/modelRerouted",
    params: { turnId: "turn-2", fromModel: "a", toModel: "b", reason: "x" },
  }, 2);
  expect(second?.id).toBe(modelRoutingActivityEntryId("turn-2"));
  expect(second?.details).toHaveLength(1);
  expect(second?.createdAt).toBe(2);
});
