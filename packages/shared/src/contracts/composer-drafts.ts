import type { AppServerBackendKind, ThreadIdentifier } from "./normalized-app-server";
import type { NavigationLaunchpadImageAttachment } from "./navigation";

export type ComposerDraftScopeKind = "thread" | "launchpad" | "empty";

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
};

export type ComposerDraftSnapshotRecord = {
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

export type ListComposerDraftLatestResponse = {
  drafts: ComposerDraftSnapshotRecord[];
};
