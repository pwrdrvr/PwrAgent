import { readFileSync } from "node:fs";
import path from "node:path";
import { MAX_CHECKOUT_HOLD_MS } from "@pwragent/owner-core/resource-checkout-authority";
import type { CheckoutDefinition } from "@pwragent/owner-core/resource-checkout-storage";
import { isResourceQueueOrder, RESOURCE_QUEUE_ORDERS, type ResourceQueueOrder } from "@pwragent/shared/contracts/resource-checkouts";
import { canonicalKey as parseCanonicalKey, object, positiveInt, text } from "./checkout-input";

export type ExternalBinding = {
  authorityInstanceId: string;
  authorityMachineId: string;
  allowedInstances: string[];
  definition: CheckoutDefinition;
};

/** A domain's optional queue order. Changing it takes a new revision, like any definition change. */
function queueOrder(value: unknown): ResourceQueueOrder {
  if (!isResourceQueueOrder(value)) throw new Error(`Invalid queue order; use one of ${RESOURCE_QUEUE_ORDERS.join(", ")}.`);
  return value;
}

export function readExternalCheckoutBindings(root: string): { bindings: ExternalBinding[]; allowAgentDrafts: boolean } {
  let raw: string;
  try {
    raw = readFileSync(path.join(root, "resource-checkout-authorities.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bindings: [], allowAgentDrafts: false };
    throw error;
  }
  const config = object(JSON.parse(raw));
  if (config.version !== 1 || !Array.isArray(config.domains) || config.domains.length > 100) {
    throw new Error("Invalid resource checkout authorities configuration.");
  }
  const keys = new Set<string>();
  const bindings = config.domains.map((value: unknown): ExternalBinding => {
    const domain = object(value);
    const canonicalKey = parseCanonicalKey(domain.canonicalKey);
    if (keys.has(canonicalKey)) throw new Error("Duplicate canonical resource authority binding.");
    keys.add(canonicalKey);
    const authorityInstanceId = text(domain.authorityInstanceId, "authority instance ID");
    const authorityMachineId = text(domain.authorityMachineId, "authority machine ID");
    if (!Array.isArray(domain.allowedInstances) || domain.allowedInstances.length > 100) {
      throw new Error("An explicit checkout peer allowlist is required.");
    }
    const capacity = positiveInt(domain.capacity, "capacity", 1_000);
    const revision = positiveInt(domain.revision, "definition revision");
    const updatedAt = positiveInt(domain.updatedAt, "definition update time");
    return {
      authorityInstanceId, authorityMachineId,
      allowedInstances: domain.allowedInstances.map((id: unknown) => text(id, "allowed instance ID")),
      definition: {
        resourceId: canonicalKey, canonicalKey, scope: "federation", counted: capacity > 1, capacity,
        displayName: text(domain.displayName, "display name"), kindLabel: text(domain.kindLabel, "kind"),
        authorityId: `checkout:${authorityInstanceId}:${canonicalKey}`,
        epoch: positiveInt(domain.epoch, "authority epoch"),
        maxHoldMs: positiveInt(domain.maxHoldMs, "maximum hold", MAX_CHECKOUT_HOLD_MS), updatedAt,
        publication: "published", revision,
        ...(domain.queueOrder === undefined ? {} : { queueOrder: queueOrder(domain.queueOrder) }),
        ...(domain.instructions === undefined ? {} : { instructions: {
          revision, title: "Operating instructions", source: "pwragent" as const,
          sourceLabel: "Operator-managed definition", excerpt: text(domain.instructions, "instructions", 4_000), updatedAt,
        } }),
      },
    };
  });
  return { bindings, allowAgentDrafts: config.allowAgentDrafts === true };
}
