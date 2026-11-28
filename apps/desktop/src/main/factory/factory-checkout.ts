import type { FactoryAdmissionRow } from "@pwragent/owner-core/factory-admission";
import { FACTORY_CPU_HOLD_MS, type FactoryCpuRequest, type FactoryCpuStatus } from "@pwragent/owner-core/resource-checkout-authority";

export function createFactoryCheckout(
  perform: (request: FactoryCpuRequest) => Promise<FactoryCpuStatus | null>,
  now = Date.now,
) {
  const call = async (row: FactoryAdmissionRow, action: FactoryCpuRequest["action"]): Promise<FactoryCpuStatus | null> => {
    if (row.resourceId !== `machine:${row.target.machineId}:cpu`) return null;
    try {
      const reply = await perform({ action, resourceId: row.resourceId, requestId: row.id });
      if (reply?.requestId !== row.id || reply.resourceId !== row.resourceId) return null;
      if (reply.state === "ended") return reply;
      if (reply.state === "granted" && typeof reply.allocationId === "string" && reply.allocationId
          && Number.isSafeInteger(reply.generation) && reply.generation > 0
          && Number.isSafeInteger(reply.deadlineAt) && reply.deadlineAt > now()) return reply;
    } catch {
      // A lost response proves neither capacity nor absence.
    }
    return null;
  };
  return {
    acquire: async (row: FactoryAdmissionRow): Promise<"granted" | "rejected" | "uncertain"> => {
      const proof = await call(row, row.phase === "dispatching" ? "status" : "reserve");
      if (!proof) return "uncertain";
      if (proof.state === "ended") return "rejected";
      return proof.deadlineAt >= row.createdAt + FACTORY_CPU_HOLD_MS ? "granted" : "uncertain";
    },
    capacity: (row: FactoryAdmissionRow) => call(row, "status"),
    release: async (row: FactoryAdmissionRow): Promise<boolean> => (await call(row, "release"))?.state === "ended",
  };
}
