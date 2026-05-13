import type {
  AppServerBackendKind,
  AppServerBackendScope,
  DirectoryLaunchpadOverlayState,
  NavigationLaunchpadDefaults,
  ThreadExecutionMode,
  ThreadMessagingBindingTransition,
  ThreadMessagingBindingTransitionAction,
  ThreadOverlayState,
  ThreadPermissionTransition,
  ThreadPermissionTransitionStatus,
} from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";

export const CURRENT_OVERLAY_STORE_VERSION = 5;

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
  launchpadDefaults: NavigationLaunchpadDefaults;
  directoryLaunchpads: Record<string, DirectoryLaunchpadOverlayState>;
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
  launchpadDefaults: {
    backend: "codex",
    executionMode: "default",
    workMode: "local",
  },
  directoryLaunchpads: {},
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

function migrateLaunchpadImageAttachments(
  value: unknown,
): DirectoryLaunchpadOverlayState["imageAttachments"] {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const attachments = value.flatMap((item) => {
    const record = asRecord(item);
    if (
      !record ||
      typeof record.id !== "string" ||
      typeof record.name !== "string" ||
      typeof record.size !== "number" ||
      typeof record.type !== "string" ||
      typeof record.url !== "string"
    ) {
      return [];
    }

    return [
      {
        id: record.id,
        height: typeof record.height === "number" ? record.height : undefined,
        name: record.name,
        size: record.size,
        type: record.type,
        url: record.url,
        width: typeof record.width === "number" ? record.width : undefined,
      },
    ];
  });

  return attachments.length > 0 ? attachments : undefined;
}

function isPermissionTransitionStatus(
  value: unknown,
): value is ThreadPermissionTransitionStatus {
  return value === "queued" || value === "applied" || value === "cancelled";
}

function migratePermissionTransitionLog(
  value: unknown,
): ThreadOverlayState["permissionTransitionLog"] {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value.flatMap((item): ThreadPermissionTransition[] => {
    const record = asRecord(item);
    if (
      !record ||
      typeof record.id !== "string" ||
      typeof record.occurredAt !== "number" ||
      !isPermissionTransitionStatus(record.status)
    ) {
      return [];
    }
    return [
      {
        id: record.id,
        fromExecutionMode: normalizeExecutionMode(record.fromExecutionMode),
        toExecutionMode: normalizeExecutionMode(record.toExecutionMode),
        status: record.status,
        occurredAt: record.occurredAt,
        queueId:
          typeof record.queueId === "string" ? record.queueId : undefined,
        note: typeof record.note === "string" ? record.note : undefined,
      },
    ];
  });
  return entries.length > 0 ? entries : undefined;
}

function isMessagingBindingTransitionAction(
  value: unknown,
): value is ThreadMessagingBindingTransitionAction {
  return value === "bound" || value === "unbound";
}

function migrateMessagingBindingTransitionLog(
  value: unknown,
): ThreadOverlayState["messagingBindingTransitionLog"] {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value.flatMap((item): ThreadMessagingBindingTransition[] => {
    const record = asRecord(item);
    if (
      !record ||
      typeof record.id !== "string" ||
      typeof record.bindingId !== "string" ||
      typeof record.platform !== "string" ||
      typeof record.occurredAt !== "number" ||
      !isMessagingBindingTransitionAction(record.action)
    ) {
      return [];
    }
    return [
      {
        id: record.id,
        action: record.action,
        bindingId: record.bindingId,
        platform: record.platform as ThreadMessagingBindingTransition["platform"],
        conversationKind:
          typeof record.conversationKind === "string"
            ? (record.conversationKind as ThreadMessagingBindingTransition["conversationKind"])
            : undefined,
        conversationTitle:
          typeof record.conversationTitle === "string"
            ? record.conversationTitle
            : undefined,
        parentTitle:
          typeof record.parentTitle === "string"
            ? record.parentTitle
            : undefined,
        ancestorTitle:
          typeof record.ancestorTitle === "string"
            ? record.ancestorTitle
            : undefined,
        occurredAt: record.occurredAt,
      },
    ];
  });
  return entries.length > 0 ? entries : undefined;
}

function migrateThreadReactions(
  value: unknown,
): ThreadOverlayState["reactions"] {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const reactions = value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
  return reactions.length > 0 ? Array.from(new Set(reactions)) : undefined;
}

function migrateRetainedBranchDriftPairs(
  value: unknown,
): ThreadOverlayState["retainedBranchDriftPairs"] {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const pairs = value.flatMap((item) => {
    const record = asRecord(item);
    if (
      !record ||
      typeof record.expectedBranch !== "string" ||
      typeof record.observedBranch !== "string"
    ) {
      return [];
    }

    return [
      {
        expectedBranch: record.expectedBranch,
        observedBranch: record.observedBranch,
        retainedAt: typeof record.retainedAt === "number" ? record.retainedAt : Date.now(),
      },
    ];
  });

  return pairs.length > 0 ? pairs : undefined;
}

export function migrateOverlayStoreData(raw: unknown): OverlayStoreData {
  const record = asRecord(raw);
  if (!record) {
    return structuredClone(EMPTY_OVERLAY_STORE_DATA);
  }

  const version =
    typeof record.version === "number" ? record.version : CURRENT_OVERLAY_STORE_VERSION;
  const backendsRecord = asRecord(record.backends) ?? {};
  const launchpadDefaultsRecord = asRecord(record.launchpadDefaults) ?? {};
  const directoryLaunchpadsRecord = asRecord(record.directoryLaunchpads) ?? {};
  const threadsRecord = asRecord(record.threads) ?? {};

  return {
    version,
    backends: {
      codex: migrateBackendState("codex", backendsRecord.codex),
      grok: migrateBackendState("grok", backendsRecord.grok),
      all: migrateBackendState("all", backendsRecord.all),
    },
    launchpadDefaults: {
      backend:
        launchpadDefaultsRecord.backend === "grok" ||
        launchpadDefaultsRecord.backend === "codex"
          ? (launchpadDefaultsRecord.backend as AppServerBackendKind)
          : "codex",
      executionMode: normalizeExecutionMode(launchpadDefaultsRecord.executionMode),
      workMode: launchpadDefaultsRecord.workMode === "worktree" ? "worktree" : "local",
      model:
        typeof launchpadDefaultsRecord.model === "string"
          ? launchpadDefaultsRecord.model
          : undefined,
      reasoningEffort:
        typeof launchpadDefaultsRecord.reasoningEffort === "string"
          ? launchpadDefaultsRecord.reasoningEffort
          : undefined,
      serviceTier:
        typeof launchpadDefaultsRecord.serviceTier === "string"
          ? launchpadDefaultsRecord.serviceTier
          : undefined,
      fastMode:
        typeof launchpadDefaultsRecord.fastMode === "boolean"
          ? launchpadDefaultsRecord.fastMode
          : undefined,
    },
    directoryLaunchpads: Object.fromEntries(
      Object.entries(directoryLaunchpadsRecord).map(([directoryKey, value]) => {
        const launchpadRecord = asRecord(value) ?? {};
        const now = Date.now();
        return [
          directoryKey,
          {
            directoryKey,
            directoryKind:
              launchpadRecord.directoryKind === "workspace" ||
              launchpadRecord.directoryKind === "unlinked"
                ? launchpadRecord.directoryKind
                : "directory",
            directoryLabel:
              typeof launchpadRecord.directoryLabel === "string"
                ? launchpadRecord.directoryLabel
                : directoryKey,
            directoryPath:
              typeof launchpadRecord.directoryPath === "string"
                ? launchpadRecord.directoryPath
                : undefined,
            backend:
              launchpadRecord.backend === "grok" || launchpadRecord.backend === "codex"
                ? (launchpadRecord.backend as AppServerBackendKind)
                : "codex",
            executionMode: normalizeExecutionMode(launchpadRecord.executionMode),
            prompt:
              typeof launchpadRecord.prompt === "string" ? launchpadRecord.prompt : "",
            imageAttachments: migrateLaunchpadImageAttachments(
              launchpadRecord.imageAttachments,
            ),
            workMode:
              launchpadRecord.workMode === "worktree" ? "worktree" : "local",
            branchName:
              typeof launchpadRecord.branchName === "string"
                ? launchpadRecord.branchName
                : undefined,
            model:
              typeof launchpadRecord.model === "string"
                ? launchpadRecord.model
                : undefined,
            reasoningEffort:
              typeof launchpadRecord.reasoningEffort === "string"
                ? launchpadRecord.reasoningEffort
                : undefined,
            serviceTier:
              typeof launchpadRecord.serviceTier === "string"
                ? launchpadRecord.serviceTier
                : undefined,
            fastMode:
              typeof launchpadRecord.fastMode === "boolean"
                ? launchpadRecord.fastMode
                : undefined,
            settingsTouchedAt:
              typeof launchpadRecord.settingsTouchedAt === "number"
                ? launchpadRecord.settingsTouchedAt
                : undefined,
            registeredAt:
              typeof launchpadRecord.registeredAt === "number"
                ? launchpadRecord.registeredAt
                : undefined,
            createdAt:
              typeof launchpadRecord.createdAt === "number"
                ? launchpadRecord.createdAt
                : now,
            updatedAt:
              typeof launchpadRecord.updatedAt === "number"
                ? launchpadRecord.updatedAt
                : now,
          } satisfies DirectoryLaunchpadOverlayState,
        ];
      }),
    ),
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
            model:
              typeof threadRecord.model === "string"
                ? threadRecord.model
                : undefined,
            reasoningEffort:
              typeof threadRecord.reasoningEffort === "string"
                ? threadRecord.reasoningEffort
                : undefined,
            serviceTier:
              typeof threadRecord.serviceTier === "string"
                ? threadRecord.serviceTier
                : undefined,
            fastMode:
              typeof threadRecord.fastMode === "boolean"
                ? threadRecord.fastMode
                : undefined,
            gitBranch:
              typeof threadRecord.gitBranch === "string"
                ? threadRecord.gitBranch
                : undefined,
            observedGitBranch:
              typeof threadRecord.observedGitBranch === "string"
                ? threadRecord.observedGitBranch
                : undefined,
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
            retainedBranchDriftPairs: migrateRetainedBranchDriftPairs(
              threadRecord.retainedBranchDriftPairs,
            ),
            extraLinkedDirectories: Array.isArray(threadRecord.extraLinkedDirectories)
              ? (threadRecord.extraLinkedDirectories as ThreadOverlayState["extraLinkedDirectories"])
              : [],
            worktreeSnapshots: Array.isArray(threadRecord.worktreeSnapshots)
              ? (threadRecord.worktreeSnapshots as ThreadOverlayState["worktreeSnapshots"])
              : [],
            permissionTransitionLog: migratePermissionTransitionLog(
              threadRecord.permissionTransitionLog,
            ),
            messagingBindingTransitionLog: migrateMessagingBindingTransitionLog(
              threadRecord.messagingBindingTransitionLog,
            ),
            reactions: migrateThreadReactions(threadRecord.reactions),
          } satisfies ThreadOverlayState,
        ];
      }),
    ),
  };
}
