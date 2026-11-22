import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  activateCheckoutRecovery, beginCheckoutRecovery, checkProductionHostEnrollment,
  checkoutIssuerMayServe, extendCheckoutFence, planCheckoutRecovery, type CheckoutRegistryRecord,
} from "../resource-checkout-recovery";

describe("resource checkout registry recovery", () => {
  it("closes the old issuers and opens only the fully fenced successor at a higher epoch and generation floor", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 1_000 }),
      fc.array(fc.tuple(fc.integer({ min: 1, max: 1_000 }), fc.nat(10_000)), { minLength: 1, maxLength: 5 }),
      fc.nat(), fc.nat(10_000),
      (epoch, contenders, selector, previousGeneration) => {
        const old = { authorityId: "owner", incarnation: "first", epoch };
        const current: CheckoutRegistryRecord = {
          domain: "external:fixture:account:member", revision: 5, phase: "active",
          issuer: old, checkpoint: "accepted-first", epochFloor: epoch, generationFloor: previousGeneration,
        };
        const conflicting = contenders.map(([epoch], index) => ({ authorityId: "competing", incarnation: String(index), epoch }));
        const destination = { authorityId: selector % 2 ? "owner" : "successor", incarnation: "new" };
        const fencing = beginCheckoutRecovery(current, current.revision, conflicting, destination)!;
        expect(checkoutIssuerMayServe(fencing, { issuer: old, checkpoint: current.checkpoint, generationHighWater: previousGeneration })).toBe(false);
        expect(beginCheckoutRecovery(fencing, current.revision, [], destination)).toBeUndefined();

        const proofs = [old, ...conflicting].map((issuer, i) => ({
          domain: current.domain, revision: fencing.revision, issuer,
          admissionClosed: true as const, effectsDrained: true as const, delayedCommandsFenced: true as const,
          stopGuardsRetired: true as const, generationHighWater: i === 0 ? previousGeneration : contenders[i - 1]![1],
          receipt: "proof-" + i,
        }));
        const missing = selector % proofs.length;
        expect(planCheckoutRecovery(fencing, proofs.filter((_, i) => i !== missing))).toBeUndefined();
        expect(planCheckoutRecovery(fencing, proofs.map((proof, i) => i === missing ? { ...proof, revision: proof.revision - 1 } : proof))).toBeUndefined();

        const prepared = planCheckoutRecovery(fencing, [...proofs].reverse())!;
        expect(prepared.issuer.epoch).toBe(Math.max(epoch, ...contenders.map(([epoch]) => epoch)) + 1);
        expect(prepared.generationFloor).toBe(Math.max(previousGeneration, ...contenders.map(([, generation]) => generation)));
        const checkpoint = {
          ...prepared, domain: current.domain, revision: fencing.revision, receipt: "new-checkpoint",
          executableGrants: 0 as const, executableWaiters: 0 as const,
        };
        expect(activateCheckoutRecovery(fencing, fencing.revision, proofs, { ...checkpoint, generationFloor: prepared.generationFloor - 1 })).toBeUndefined();
        const surprise = { authorityId: "late", incarnation: "late-issuer", epoch: prepared.issuer.epoch + 1 };
        const expanded = extendCheckoutFence(fencing, fencing.revision, surprise)!;
        expect(planCheckoutRecovery(expanded, proofs)).toBeUndefined();
        expect(activateCheckoutRecovery(expanded, fencing.revision, proofs, checkpoint)).toBeUndefined();
        expect(expanded.epochFloor).toBe(surprise.epoch);
        const next = activateCheckoutRecovery(fencing, fencing.revision, proofs, checkpoint)!;
        expect(checkoutIssuerMayServe(next, { issuer: old, checkpoint: current.checkpoint, generationHighWater: previousGeneration })).toBe(false);
        expect(checkoutIssuerMayServe(next, { issuer: prepared.issuer, checkpoint: current.checkpoint, generationHighWater: prepared.generationFloor })).toBe(false);
        expect(checkoutIssuerMayServe(next, { issuer: prepared.issuer, checkpoint: checkpoint.receipt, generationHighWater: prepared.generationFloor })).toBe(true);
        expect(activateCheckoutRecovery(next, fencing.revision, proofs, checkpoint)).toBeUndefined();
      },
    ));
  });

  it("admits only explicitly enrolled roots with the same authenticated platform broker and domain", () => {
    fc.assert(fc.property(fc.uniqueArray(fc.uuid(), { minLength: 2, maxLength: 5 }), fc.nat(), (roots, choice) => {
      const broker = { platformHostId: "host", brokerId: "broker", domain: "cpu", enrolledRoots: roots };
      for (const rootId of roots) {
        expect(checkProductionHostEnrollment({ ...broker, rootId }, broker)).toBe("enrolled");
      }
      const rootId = roots[choice % roots.length]!;
      const enrollment = { ...broker, rootId };
      expect(checkProductionHostEnrollment(enrollment, undefined)).toBe("unresolved");
      expect(checkProductionHostEnrollment({ ...enrollment, rootId: "restored-root" }, broker)).toBe("unresolved");
      expect(checkProductionHostEnrollment({ ...enrollment, platformHostId: "vm-clone" }, broker)).toBe("unresolved");
      expect(checkProductionHostEnrollment({ ...enrollment, brokerId: "second-broker" }, broker)).toBe("unresolved");
      expect(checkProductionHostEnrollment({ ...enrollment, domain: "extra-cpu" }, broker)).toBe("unresolved");
    }));
  });
});
