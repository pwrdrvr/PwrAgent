import type {
  AppServerBackendKind,
  AppServerBackendScope,
  ThreadExecutionMode,
  ThreadOverlayState,
} from "@pwragnt/shared";
import { buildThreadIdentityKey } from "@pwragnt/shared";

export const CURRENT_OVERLAY_STORE_VERSION = 3;

export type OverlayStoreData = {
  version: number;
  backends: Partial<
    Record<
      AppServerBackendKind,
      {
        knownThreadKeys: string[];
        lastSnapshotHash?: string;
      }
    > &
      Partial<
        Record<
          Extract<AppServerBackendScope, "all">,
          {
            knownThreadKeys: string[];
            lastSnapshotHash?: string;
          }
        >
      >
  >;
  threads: Record<string, ThreadOverlayState>;
};

function migrateBackendState(
  scope: AppServerBackendScope,
  value: unknown,
): { knownThreadKeys: string[]; lastSnapshotHash?: string } | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const knownThreadKeys = Array.isArray(record.knownThreadKeys)
    ? (record.knownThreadKeys as string[])
    : Array.isArray(record.knownThreadIds)
      ? (record.knownThreadIds as string[]).map((threadId) =>
          scope === "all" ? threadId : buildThreadIdentityKey(scope, threadId),
        )
      : [];

  return {
    knownThreadKeys,
    lastSnapshotHash:
      typeof record.lastSnapshotHash === "string"
        ? (record.lastSnapshotHash as string)
        : undefined,
  };
}

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

function normalizeExecutionMode(value: unknown): ThreadExecutionMode {
  return value === "full-access" ? "full-access" : "default";
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
      codex: migrateBackendState("codex", backendsRecord.codex),
      grok: migrateBackendState("grok", backendsRecord.grok),
      all: migrateBackendState("all", backendsRecord.all),
    },
    threads: Object.fromEntries(
      Object.entries(threadsRecord).map(([rawKey, value]) => {
        const threadRecord = asRecord(value) ?? {};
        const threadId =
          typeof threadRecord.threadId === "string" ? threadRecord.threadId : rawKey;
        const backend =
          threadRecord.backend === "grok" || threadRecord.backend === "codex"
            ? (threadRecord.backend as AppServerBackendKind)
            : "codex";
        const threadKey = buildThreadIdentityKey(backend, threadId);

        return [
          threadKey,
          {
            backend,
            threadId,
            executionMode: normalizeExecutionMode(threadRecord.executionMode),
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
