import { isAppServerBackendKind, type NavigationIdentity } from "./contracts/navigation";

/** Desktop metadata only; query cursors and provider transcripts are never durable. */
export type NavigationResumeState = {
  version: 1;
  selection: NavigationIdentity | null;
  expandedByKey: Record<string, boolean>;
  unpinnedExpandedByKey: Record<string, boolean>;
  loadedRowsByQuery: Record<string, number>;
};

// This snapshot also travels in the renderer's bootstrap arguments. Leave
// room for Electron's other arguments on Windows (32K UTF-16 command line).
const MAX_RESUME_LENGTH = 12 * 1024;

export function normalizeNavigationResumeState(value: unknown): NavigationResumeState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) return undefined;
  let selection: NavigationIdentity | null = null;
  if (raw.selection !== null) {
    if (!raw.selection || typeof raw.selection !== "object") return undefined;
    const ref = raw.selection as Record<string, unknown>;
    if (typeof ref.backend !== "string" || !isAppServerBackendKind(ref.backend) || typeof ref.threadId !== "string" || !ref.threadId
      || (ref.ownerInstanceId !== undefined && (typeof ref.ownerInstanceId !== "string" || !ref.ownerInstanceId))) return undefined;
    selection = { backend: ref.backend, threadId: ref.threadId,
      ...(typeof ref.ownerInstanceId === "string" ? { ownerInstanceId: ref.ownerInstanceId } : {}) };
  }
  const entries = (field: unknown): [string, unknown][] => field && typeof field === "object" && !Array.isArray(field)
    ? Object.entries(field).filter(([key]) => key.length > 0 && key.length <= 2048).sort(([a], [b]) => a.localeCompare(b)) : [];
  const booleans = (field: unknown): Record<string, boolean> => Object.fromEntries(entries(field).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
  const result: NavigationResumeState = {
    version: 1, selection,
    expandedByKey: booleans(raw.expandedByKey),
    unpinnedExpandedByKey: booleans(raw.unpinnedExpandedByKey),
    loadedRowsByQuery: Object.fromEntries(entries(raw.loadedRowsByQuery).filter((entry): entry is [string, number] =>
      typeof entry[1] === "number" && Number.isSafeInteger(entry[1]) && entry[1] > 0 && entry[1] <= 100_000)),
  };
  let length = JSON.stringify(result).length;
  // Pagination and disclosures are optional. Trim them deterministically so
  // accumulated metadata can never prevent saving the current selection.
  for (const field of [result.loadedRowsByQuery, result.unpinnedExpandedByKey, result.expandedByKey]) {
    const optional = Object.entries(field);
    for (let index = optional.length - 1; index >= 0 && length > MAX_RESUME_LENGTH; index -= 1) {
      const [key, entry] = optional[index]!;
      delete field[key];
      length -= JSON.stringify(key).length + 1 + JSON.stringify(entry).length + (index > 0 ? 1 : 0);
    }
  }
  return length <= MAX_RESUME_LENGTH ? result : undefined;
}
