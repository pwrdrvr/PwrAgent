/**
 * The registry applies each transition with compare-and-swap against a witness
 * stored outside all authority backups. The policy here is pure so the
 * operator can rehearse the same procedure without touching either authority.
 */
export type CheckoutIssuer = {
  authorityId: string;
  incarnation: string;
  epoch: number;
};

export type CheckoutRegistryRecord = {
  domain: string;
  revision: number;
  epochFloor: number;
  generationFloor: number;
} & ({
  phase: "active";
  issuer: CheckoutIssuer;
  checkpoint: string;
} | {
  phase: "fencing";
  priorIssuers: readonly CheckoutIssuer[];
  successor: Omit<CheckoutIssuer, "epoch">;
});

type FenceEvidence = {
  domain: string;
  revision: number;
  issuer: CheckoutIssuer;
  admissionClosed: true;
  effectsDrained: true;
  delayedCommandsFenced: true;
  stopGuardsRetired: true;
  generationHighWater: number;
  receipt: string;
};

type RecoveredCheckpoint = {
  domain: string;
  revision: number;
  issuer: CheckoutIssuer;
  generationFloor: number;
  receipt: string;
  // A restored grant or queued wake is never executed under a new epoch.
  executableGrants: 0;
  executableWaiters: 0;
};

function issuerKey(issuer: CheckoutIssuer): string {
  return JSON.stringify([issuer.authorityId, issuer.incarnation, issuer.epoch]);
}

function validCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
}

/** Quarantine every known competing issuer at the witness before observing any drain proof. */
export function beginCheckoutRecovery(
  current: CheckoutRegistryRecord,
  expectedRevision: number,
  contenders: readonly CheckoutIssuer[],
  successor: Omit<CheckoutIssuer, "epoch">,
): Extract<CheckoutRegistryRecord, { phase: "fencing" }> | undefined {
  if (current.phase !== "active" || current.revision !== expectedRevision || !validCounter(expectedRevision)
    || !successor.authorityId || !successor.incarnation) return undefined;
  const priorIssuers = [...new Map([current.issuer, ...contenders].map((issuer) => [issuerKey(issuer), issuer])).values()];
  if (priorIssuers.some((issuer) => !issuer.authorityId || !issuer.incarnation || !validCounter(issuer.epoch)
    || issuer.incarnation === successor.incarnation)) return undefined;
  return {
    domain: current.domain, phase: "fencing", revision: expectedRevision + 1,
    epochFloor: Math.max(current.epochFloor, ...priorIssuers.map(({ epoch }) => epoch)),
    generationFloor: current.generationFloor, priorIssuers, successor,
  };
}

/** A newly discovered issuer revokes all earlier proofs and staged checkpoints. */
export function extendCheckoutFence(
  current: CheckoutRegistryRecord,
  expectedRevision: number,
  contender: CheckoutIssuer,
): Extract<CheckoutRegistryRecord, { phase: "fencing" }> | undefined {
  if (current.phase !== "fencing" || current.revision !== expectedRevision || !validCounter(expectedRevision)
    || !contender.authorityId || !contender.incarnation || !validCounter(contender.epoch)
    || contender.incarnation === current.successor.incarnation || current.priorIssuers.some((issuer) => issuerKey(issuer) === issuerKey(contender))) return undefined;
  return {
    ...current, revision: expectedRevision + 1, epochFloor: Math.max(current.epochFloor, contender.epoch),
    priorIssuers: [...current.priorIssuers, contender],
  };
}

/** The destination prepares a disabled checkpoint only after all known issuers have been fenced. */
export function planCheckoutRecovery(
  current: CheckoutRegistryRecord,
  evidence: readonly FenceEvidence[],
): { issuer: CheckoutIssuer; generationFloor: number } | undefined {
  if (current.phase !== "fencing" || !validCounter(current.epochFloor)) return undefined;
  const proofs = new Map(evidence.map((proof) => [issuerKey(proof.issuer), proof]));
  if (proofs.size !== evidence.length || proofs.size !== current.priorIssuers.length) return undefined;
  for (const issuer of current.priorIssuers) {
    const proof = proofs.get(issuerKey(issuer));
    if (!proof || proof.domain !== current.domain || proof.revision !== current.revision || !proof.receipt
      || !proof.admissionClosed || !proof.effectsDrained || !proof.delayedCommandsFenced || !proof.stopGuardsRetired
      || !validCounter(proof.generationHighWater)) return undefined;
  }
  return {
    issuer: { ...current.successor, epoch: current.epochFloor + 1 },
    generationFloor: Math.max(current.generationFloor, ...evidence.map(({ generationHighWater }) => generationHighWater)),
  };
}

/** Publish only the exact staged successor. Concurrent or repeated activations must fail CAS. */
export function activateCheckoutRecovery(
  current: CheckoutRegistryRecord,
  expectedRevision: number,
  evidence: readonly FenceEvidence[],
  checkpoint: RecoveredCheckpoint,
): CheckoutRegistryRecord | undefined {
  if (current.revision !== expectedRevision || !validCounter(expectedRevision)) return undefined;
  const plan = planCheckoutRecovery(current, evidence);
  if (!plan || checkpoint.domain !== current.domain || checkpoint.revision !== current.revision
    || issuerKey(checkpoint.issuer) !== issuerKey(plan.issuer) || checkpoint.generationFloor !== plan.generationFloor
    || !checkpoint.receipt || checkpoint.executableGrants !== 0 || checkpoint.executableWaiters !== 0) return undefined;
  return {
    phase: "active", domain: current.domain, revision: expectedRevision + 1, issuer: plan.issuer,
    checkpoint: checkpoint.receipt, epochFloor: plan.issuer.epoch, generationFloor: plan.generationFloor,
  };
}

/** An allocator or an executor with a copied store must still consult the current witness. */
export function checkoutIssuerMayServe(
  current: CheckoutRegistryRecord,
  presented: { issuer: CheckoutIssuer; checkpoint: string; generationHighWater: number },
): boolean {
  // The witness checkpoint is the latest admitted durable state, including
  // changes that do not advance a grant generation, such as releasing one.
  return current.phase === "active" && issuerKey(current.issuer) === issuerKey(presented.issuer)
    && !!presented.checkpoint && current.checkpoint === presented.checkpoint
    && presented.generationHighWater === current.generationFloor;
}

export type ProductionHostEnrollment = {
  rootId: string;
  platformHostId: string;
  brokerId: string;
  domain: string;
};

/** Alternate production roots join the authenticated OS broker's single physical conflict domain. */
export function checkProductionHostEnrollment(
  presented: ProductionHostEnrollment,
  broker: { platformHostId: string; brokerId: string; domain: string; enrolledRoots: readonly string[] } | undefined,
): "enrolled" | "unresolved" {
  if (!broker || !presented.rootId || !presented.platformHostId || !presented.brokerId || !presented.domain) return "unresolved";
  return broker.platformHostId === presented.platformHostId && broker.brokerId === presented.brokerId
    && broker.domain === presented.domain && broker.enrolledRoots.includes(presented.rootId) ? "enrolled" : "unresolved";
}
