import type { AppServerBackendKind, ThreadOverlayState } from "@pwragnt/shared";

export const CURRENT_OVERLAY_STORE_VERSION = 1;

export type OverlayStoreData = {
  version: number;
  backends: Partial<
    Record<
      AppServerBackendKind,
      {
        knownThreadIds: string[];
        lastSnapshotHash?: string;
      }
    >
  >;
  threads: Record<string, ThreadOverlayState>;
};

const EMPTY_OVERLAY_STORE_DATA: OverlayStoreData = {
  version: CURRENT_OVERLAY_STORE_VERSION,
  backends: {},
  threads: {},
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

export function migrateOverlayStoreData(raw: unknown): OverlayStoreData {
  const record = asRecord(raw);
  if (!record) {
    return structuredClone(EMPTY_OVERLAY_STORE_DATA);
  }

  const version =
    typeof record.version === "number" ? record.version : CURRENT_OVERLAY_STORE_VERSION;
  const backendsRecord = asRecord(record.backends) ?? {};
  const threadsRecord = asRecord(record.threads) ?? {};

  return {
    version,
    backends: {
      codex: asRecord(backendsRecord.codex)
        ? {
            knownThreadIds: Array.isArray(asRecord(backendsRecord.codex)?.knownThreadIds)
              ? (asRecord(backendsRecord.codex)?.knownThreadIds as string[])
              : [],
            lastSnapshotHash:
              typeof asRecord(backendsRecord.codex)?.lastSnapshotHash === "string"
                ? (asRecord(backendsRecord.codex)?.lastSnapshotHash as string)
                : undefined,
          }
        : undefined,
      grok: asRecord(backendsRecord.grok)
        ? {
            knownThreadIds: Array.isArray(asRecord(backendsRecord.grok)?.knownThreadIds)
              ? (asRecord(backendsRecord.grok)?.knownThreadIds as string[])
              : [],
            lastSnapshotHash:
              typeof asRecord(backendsRecord.grok)?.lastSnapshotHash === "string"
                ? (asRecord(backendsRecord.grok)?.lastSnapshotHash as string)
                : undefined,
          }
        : undefined,
    },
    threads: Object.fromEntries(
      Object.entries(threadsRecord).map(([threadId, value]) => {
        const threadRecord = asRecord(value) ?? {};
        return [
          threadId,
          {
            threadId,
            lastSeenAt:
              typeof threadRecord.lastSeenAt === "number"
                ? threadRecord.lastSeenAt
                : undefined,
            lastSeenUpdatedAt:
              typeof threadRecord.lastSeenUpdatedAt === "number"
                ? threadRecord.lastSeenUpdatedAt
                : undefined,
            dismissedAt:
              typeof threadRecord.dismissedAt === "number"
                ? threadRecord.dismissedAt
                : undefined,
            snoozedUntil:
              typeof threadRecord.snoozedUntil === "number"
                ? threadRecord.snoozedUntil
                : undefined,
            extraLinkedDirectories: Array.isArray(threadRecord.extraLinkedDirectories)
              ? (threadRecord.extraLinkedDirectories as ThreadOverlayState["extraLinkedDirectories"])
              : [],
          } satisfies ThreadOverlayState,
        ];
      }),
    ),
  };
}
