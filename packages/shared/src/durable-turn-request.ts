import type { SubmitDurableTurnRequest } from "./contracts/durable-turn-requests";

/** V1 canonical JSON: sorted object keys, ordered arrays, JSON scalar encoding.
 * Only JSON data is accepted. Optional undefined object fields are omitted.
 * Hash the UTF-8 result with SHA-256 on the client's native crypto API.
 */
export function canonicalDurableTurnRequest(
  ownerInstanceId: string,
  submission: Omit<SubmitDurableTurnRequest, "clientRequest"> & {
    clientRequest: Pick<SubmitDurableTurnRequest["clientRequest"], "version" | "createdAt">;
  },
): string {
  return canonicalJson({
    version: submission.clientRequest.version,
    createdAt: submission.clientRequest.createdAt,
    operation: "startTurn",
    destination: {
      instanceId: ownerInstanceId,
      backend: submission.request.backend,
      threadId: submission.request.threadId,
    },
    request: submission.request,
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new Error("Durable turn requests must contain only finite JSON values.");
}
