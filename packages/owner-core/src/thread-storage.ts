import type { AppServerBackendKind, AppServerThreadTitleSource, ThreadExecutionMode } from "@pwragent/shared";

/** Local owner identity. A mounted peer is never an entry in this registry. */
export type OwnerThreadIdentity = {
  backend: AppServerBackendKind;
  threadId: string;
};

/** Owner facts, independent of provider sessions, job records and file formats. */
export type OwnerThreadMetadata = {
  /** A title and its provenance are one fact and are replaced together. */
  title?: { text: string; source: AppServerThreadTitleSource; nativeName?: string };
  createdAt?: number;
  updatedAt?: number;
  cwd?: string;
  executionMode?: ThreadExecutionMode;
  executionModeUpdatedAt?: number;
  model?: string;
  reasoningEffort?: string;
  reasoningEffortsByModel?: Record<string, string>;
  modelMigrationRevision?: string;
  modelSettingsManuallyUpdatedAt?: number;
  serviceTier?: string;
  fastMode?: boolean;
  pinnedRank?: string;
  seenAt?: number;
  /** The displayed update acknowledged by the reader, not the read's time. */
  seenUpdatedAt?: number;
  /** Registry membership retained after archive or an ownership handoff. */
  archived?: boolean;
  archivedAt?: number;
  restoredAt?: number;
  archiveRetentionStartedAt?: number;
  parent?: OwnerThreadIdentity & { instanceId?: string };
  subthreadOrder?: string[];
  subthreadsCollapsed?: boolean;
  /** Provider thread was created with the messaging file-tool catalog. */
  messagingFileTools?: boolean;
  /** False confirms native membership; true records complete-discovery retirement. */
  nativeMembershipRetired?: boolean;
};

export type OwnerThreadRecord = OwnerThreadIdentity & OwnerThreadMetadata & { executionMode: ThreadExecutionMode };
export type OwnerThreadMetadataPatch = {
  [Field in keyof OwnerThreadMetadata]?: OwnerThreadMetadata[Field] | null;
};

/**
 * Durable owner metadata, including archived entries. This is not a provider
 * inventory: absence means no owner metadata has been stored. Provider discovery,
 * renames, archive operations, parent validation and events remain host/domain
 * responsibilities. Reads do not contact a provider or synthesize activity.
 */
export interface OwnerThreadRegistry {
  getThreadMetadata(identity: OwnerThreadIdentity): Promise<OwnerThreadRecord | undefined>;
  listThreadMetadata(): Promise<OwnerThreadRecord[]>;
  /**
   * Atomically merge into the latest stored entry, creating it if absent.
   * Omission/undefined preserves a field; null clears it. Preserve host-private
   * data. Inputs and returned snapshots must not alias the stored entry.
   * Execution mode defaults to "default"; null resets it to that value.
   * Reasserting unchanged facts makes no durable write.
   */
  updateThreadMetadata(identity: OwnerThreadIdentity, patch: OwnerThreadMetadataPatch): Promise<OwnerThreadRecord>;
}

/** Immediate storage permits an atomic import with other owner records. */
export interface ImmediateOwnerThreadRegistry {
  getThreadMetadata(identity: OwnerThreadIdentity): OwnerThreadRecord | undefined;
  listThreadMetadata(): OwnerThreadRecord[];
  updateThreadMetadata(identity: OwnerThreadIdentity, patch: OwnerThreadMetadataPatch): OwnerThreadRecord;
  /** Detached immutable startup watermarks, keyed by qualified thread identity. */
  readUnreadBaseline(): Readonly<Record<string, number>>;
}

export const OWNER_THREAD_METADATA_FIELDS = [
  "title", "createdAt", "updatedAt", "cwd", "pinnedRank", "seenAt", "seenUpdatedAt",
  "executionMode", "model", "reasoningEffort", "serviceTier", "fastMode",
  "executionModeUpdatedAt", "reasoningEffortsByModel", "modelMigrationRevision", "modelSettingsManuallyUpdatedAt",
  "archived", "archivedAt", "restoredAt", "archiveRetentionStartedAt", "parent", "subthreadOrder", "subthreadsCollapsed", "messagingFileTools", "nativeMembershipRetired",
] as const satisfies readonly (keyof OwnerThreadMetadata)[];

/** Storage-only patch semantics; no lifecycle policy or I/O. */
export function patchOwnerThreadMetadata(
  current: OwnerThreadRecord | undefined,
  identity: OwnerThreadIdentity,
  patch: OwnerThreadMetadataPatch,
): OwnerThreadRecord {
  const next: OwnerThreadRecord = structuredClone(current ?? { ...identity, executionMode: "default" });
  for (const field of OWNER_THREAD_METADATA_FIELDS) {
    const value = patch[field];
    if (value === null) Reflect.deleteProperty(next, field);
    else if (value !== undefined) Object.assign(next, { [field]: structuredClone(value) });
  }
  next.executionMode ??= "default";
  return next;
}
