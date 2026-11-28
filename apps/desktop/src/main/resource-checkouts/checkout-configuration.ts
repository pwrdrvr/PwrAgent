import { readFileSync } from "node:fs";
import path from "node:path";
import { MAX_CHECKOUT_HOLD_MS } from "@pwragent/owner-core/resource-checkout-authority";
import type { CheckoutDefinition } from "@pwragent/owner-core/resource-checkout-storage";
import { isResourceQueueOrder, RESOURCE_QUEUE_ORDERS, type ResourceQueueOrder } from "@pwragent/shared/contracts/resource-checkouts";
import { canonicalKey as parseCanonicalKey, object, positiveInt, text } from "./checkout-input";

export const MAX_EXTERNAL_DOMAINS = 100;
export const FACTORY_CPU_MACHINE_ID = /^mach_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export type ExternalBinding = {
  authorityInstanceId: string;
  authorityMachineId: string;
  definition: CheckoutDefinition;
};

export type FactoryCpuBinding = Pick<ExternalBinding, "authorityInstanceId" | "authorityMachineId"> & {
  allowedInstances: ReadonlySet<string>;
};

type CheckoutConfiguration = {
  bindings: ExternalBinding[];
  factoryCpuBindings: ReadonlyMap<string, FactoryCpuBinding>;
  allowAgentDrafts: boolean;
};

/** A domain's optional queue order. Changing it takes a new revision, like any definition change. */
function queueOrder(value: unknown): ResourceQueueOrder {
  if (!isResourceQueueOrder(value)) throw new Error(`Invalid queue order; use one of ${RESOURCE_QUEUE_ORDERS.join(", ")}.`);
  return value;
}

export function readExternalCheckoutBindings(root: string): CheckoutConfiguration {
  const factoryCpuBindings = new Map<string, FactoryCpuBinding>();
  let raw: string;
  try {
    raw = readFileSync(path.join(root, "resource-checkout-authorities.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bindings: [], factoryCpuBindings, allowAgentDrafts: false };
    throw error;
  }
  const config = object(JSON.parse(raw));
  if (config.version !== 1 || !Array.isArray(config.domains) || config.domains.length > MAX_EXTERNAL_DOMAINS) {
    throw new Error("Invalid resource checkout authorities configuration.");
  }
  const keys = new Set<string>();
  const bindings: ExternalBinding[] = [];
  for (const value of config.domains) {
    const domain = object(value);
    const canonicalKey = parseCanonicalKey(domain.canonicalKey);
    if (keys.has(canonicalKey)) throw new Error("Duplicate canonical resource authority binding.");
    keys.add(canonicalKey);
    const authorityInstanceId = text(domain.authorityInstanceId, "authority instance ID");
    const authorityMachineId = text(domain.authorityMachineId, "authority machine ID");
    if (canonicalKey.startsWith("factory-cpu:")) {
      if (!FACTORY_CPU_MACHINE_ID.test(authorityMachineId) || canonicalKey !== `factory-cpu:${authorityMachineId}`) {
        throw new Error("Invalid Factory CPU authority machine binding.");
      }
      const allowed = domain.allowedInstances ?? [];
      if (!Array.isArray(allowed) || allowed.length > MAX_EXTERNAL_DOMAINS) {
        throw new Error("Invalid Factory CPU gateway allowlist.");
      }
      factoryCpuBindings.set(authorityMachineId, {
        authorityInstanceId, authorityMachineId,
        allowedInstances: new Set(allowed.map((id) => text(id, "Factory CPU gateway instance ID"))),
      });
      continue;
    }
    const capacity = positiveInt(domain.capacity, "capacity", 1_000);
    const revision = positiveInt(domain.revision, "definition revision");
    const updatedAt = positiveInt(domain.updatedAt, "definition update time");
    bindings.push({
      authorityInstanceId, authorityMachineId,
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
    });
  }
  return { bindings, factoryCpuBindings, allowAgentDrafts: config.allowAgentDrafts === true };
}
