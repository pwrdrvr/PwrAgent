import type { AppServerBackendKind, ThreadIdentifier } from "./normalized-app-server";
import type { FederationTarget } from "./federation";
import type {
  NavigationLaunchpadFileAttachment,
  NavigationLaunchpadImageAttachment,
} from "./navigation";

export type ComposerDraftScopeKind = "thread" | "launchpad" | "empty";

/** Local scope metadata. An old backend/thread scope alone does not name an owner. */
export type ComposerThreadOwner = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  target: FederationTarget;
};

export type ComposerDraftLifecycle = "unsent" | "sent" | "abandoned" | "cleared";

export type ComposerDraftJsonValue =
  | null
  | boolean
  | number
  | string
  | ComposerDraftJsonValue[]
  | { [key: string]: ComposerDraftJsonValue };

export type ComposerDraftSkillToken = {
  id: string;
  index: number;
  name: string;
  path?: string;
  description?: string;
  shortDescription?: string;
  source?: string;
  /**
   * Absent for skill mentions (the original kind). "directory" marks a
   * composer directory-reference chip: `name` is the tracked directory's
   * label and `path` its absolute path. "file" marks a file-reference
   * chip: `name` is the file's basename and `path` its absolute file
   * path. Both serialize to the same `[@label](~/path)` markdown. "thread"
   * marks a known-thread reference: `name` is its display title and `path`
   * is its canonical `pwragent://thread/...` URL. "pull-request" marks a
   * repository-scoped PR reference: `name` is its `#123` label and `path` is
   * the full provider URL.
   */
  kind?: "directory" | "file" | "pull-request" | "thread";
  /**
   * Pull-request chips only: the `pr-chip--*` modifiers that give the chip its
   * status color, resolved when the chip was minted. Persisted with the draft
   * so a recovered chip comes back the color it had rather than a gray
   * "status unknown" dot. Absent on drafts written before chips carried it.
   */
  prChipModifiers?: string[];
};

export type ComposerDraftSnapshotRecord = {
  threadOwner?: ComposerThreadOwner;
  scopeKey: string;
  scopeKind: ComposerDraftScopeKind;
  backend?: AppServerBackendKind;
  threadId?: ThreadIdentifier;
  directoryKey?: string;
  directoryPath?: string;
  text: string;
  editorDocument?: ComposerDraftJsonValue;
  skillTokens: ComposerDraftSkillToken[];
  imageAttachments: NavigationLaunchpadImageAttachment[];
  fileAttachments?: NavigationLaunchpadFileAttachment[];
  status: ComposerDraftLifecycle;
  createdAt: number;
  updatedAt: number;
  contentHash: string;
  charCount: number;
};

export type ComposerDraftRecoveryCandidate = ComposerDraftSnapshotRecord & {
  journalId?: number;
};

export type SaveComposerDraftRequest = {
  draft: ComposerDraftSnapshotRecord;
  recordHistory?: boolean;
};

export type SaveComposerDraftResponse = {
  draft: ComposerDraftSnapshotRecord;
};

export type RecordComposerDraftHistoryRequest = {
  draft: ComposerDraftSnapshotRecord;
};

export type RecordComposerDraftHistoryResponse = {
  candidate: ComposerDraftRecoveryCandidate;
};

export type ClearComposerDraftRequest = {
  scopeKey: string;
  clearedAt?: number;
};

export type ClearComposerDraftResponse = {
  scopeKey: string;
};

export type ListComposerDraftRecoveryCandidatesRequest = {
  backend?: AppServerBackendKind;
  directoryKey?: string;
  includeSent?: boolean;
  limit?: number;
  scopeKey?: string;
  threadId?: ThreadIdentifier;
};

export type ListComposerDraftRecoveryCandidatesResponse = {
  candidates: ComposerDraftRecoveryCandidate[];
};

export type ListComposerDraftLatestRequest = {
  /** Explicit startup migration; never infer owners for legacy records. */
  migrateKnownOwners?: boolean;
};

export type ListComposerDraftLatestResponse = {
  drafts: ComposerDraftSnapshotRecord[];
};
