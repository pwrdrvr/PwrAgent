import type { ResourceOwnershipConflict } from "@pwragent/shared/contracts/resource-checkouts";

/**
 * Why a checkout authority is unresolved, and what the operator does next.
 *
 * Checkouts are cooperative reservations, so a conflict the operator can
 * settle from Resources offers a `resolution`. The worst outcome of a wrong
 * call is overlapping work until leases end. The rest describe a fix outside
 * the app, because the app has nothing to choose between.
 */
export const OWNERSHIP_CONFLICTS = {
  machineIdMissing: {
    reason: "This PwrAgent root has no valid machine ID.",
    remedy: "Make sure the machine-id file in the PwrAgent root is readable, then restart PwrAgent.",
  },
  alternateRoot: {
    reason: "This PwrAgent root is not this machine's primary root.",
    remedy: "Run machine work from the primary PwrAgent root.",
  },
  copiedRoot: {
    reason: "This root's checkout store was created on another machine.",
    remedy: "If this root now belongs to this machine, adopt the store. Otherwise run machine work on the machine that created it.",
    resolution: {
      kind: "adopt_store",
      label: "Adopt for this machine",
      consequence: "Checkouts and waiters copied from the other machine are dropped. They never held this machine's capacity. If another profile on this root already adopted it, its checkouts are kept.",
    },
  },
  machineStoreUnavailable: {
    reason: "This machine's checkout store could not be opened.",
    remedy: "Check the main-process log for pwragent:resource-checkouts, correct the cause, and restart PwrAgent.",
  },
  machineDefinitionChanged: {
    reason: "This machine's saved checkout record differs from the current definition.",
    remedy: "Accept the current definition to use this machine's capacity again.",
    resolution: {
      kind: "accept_definition",
      label: "Accept current definition",
      consequence: "The saved record takes the current definition. Current checkouts and the queue are kept.",
    },
  },
  federationStoreUnavailable: {
    reason: "This instance hosts the resource, but its Federation checkout store is unavailable.",
    remedy: "Hosting needs this machine's platform identity. Check the main-process log for pwragent:resource-checkouts, correct the cause, and restart PwrAgent.",
  },
  federationCopiedRoot: {
    reason: "This instance hosts the resource, but its Federation checkout store was created on another machine.",
    remedy: "Host it from the machine that created this root, or bind it to another instance in resource-checkout-authorities.json and restart every participating instance.",
  },
  definitionChanged: {
    reason: "The configured owner, epoch or capacity differs from the resource's saved record.",
    remedy: "Accept the configured definition, or restore the previous values in resource-checkout-authorities.json and restart.",
    resolution: {
      kind: "accept_definition",
      label: "Accept configured definition",
      consequence: "The saved record takes the configured owner, epoch and capacity. Current checkouts and the queue are kept. If capacity shrank, new requests wait until holds end.",
    },
  },
} as const satisfies Record<string, ResourceOwnershipConflict>;

/** A binding that names this instance as the owner on a different machine. */
export function misboundAuthorityConflict(authorityMachineId: string): ResourceOwnershipConflict {
  return {
    reason: `The authorities file binds this resource to this instance on machine ${authorityMachineId}, not on this machine.`,
    remedy: "If this profile was copied from that machine, run the authority there. Otherwise correct authorityMachineId in resource-checkout-authorities.json on every participating instance and restart them.",
  };
}
