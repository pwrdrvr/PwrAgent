import type { FactoryWorkItem } from "./factory-work-item";

/** Read-only inventory and evidence for one operator-selected local project. */
export const FACTORY_PROJECT_PAGE_LIMIT = 25;

export interface FactoryProjectOption {
  key: string;
  label: string;
  path: string;
}

export interface FactoryProjectReadRequest {
  /** Exact registered directory key from this owner's project navigation. */
  projectKey: string;
  /** Explicit GitHub repository name of the registered project’s origin. */
  repository: string;
  limit?: number;
  candidate?: FactoryBranchSelection;
  selection?: {
    /** Immutable ID returned by an earlier project read. */
    repositoryId: string;
    number: number;
    expected?: { headOid: string; baseOid: string };
    /** Operator-selected CI contexts. An empty policy cannot establish passing CI. */
    requiredChecks?: string[];
    /** Optional advisory inputs. They cannot add evidence. */
    assessment?: { outcome: string; change: string };
  };
}

export interface FactoryBranchSelection {
  workItem?: FactoryWorkItem;
  /** Legacy input for a Linear UUID. Supply one of workItem or issueId. */
  issueId?: string;
  branch: string;
  /** Full local or remote-tracking ref in the registered project's repository. */
  baseRef: string;
  /** An optional local checkout of the branch. A ref-only candidate stays readable. */
  worktree?: string;
  reviewIds?: string[];
  assessment?: { outcome: string; change: string };
}

export interface FactoryProjectPullRequest {
  number: number;
  title: string;
  url: string;
  lifecycle: "open" | "closed" | "merged";
  draft: boolean;
  firstParty: boolean;
}

export type FactoryReceiptStatus =
  | "current" | "absent" | "stale_head" | "stale_base" | "stale"
  | "inconclusive" | "pending" | "failed" | "conflict";

export interface FactoryReceiptProjection {
  kind: "test" | "review" | "integration" | "other";
  name: string;
  source: "github" | "owner_pr_status" | "owner_review";
  status: FactoryReceiptStatus;
  actor?: string;
  /** Start of a reviewed branch diff, independent of the live target tip. */
  mergeBaseOid?: string;
  required?: boolean;
  headOid?: string;
  baseOid?: string;
  reference?: string;
}

export type FactoryAssessmentPacket = ({ pullRequest: string } | {
  candidate: { issue: string; repository: string; branch: string };
}) & {
  headSha: string;
  baseSha: string;
  outcome: string;
  change: string;
  evidence: { kind: "test" | "review" | "integration"; headSha: string; baseSha?: string; reference: string; observation: string }[];
};

export interface FactoryEvidenceSnapshot {
  pullRequest: FactoryProjectPullRequest;
  revision?: { headOid: string; baseOid: string };
  revisionState: "current" | "absent" | "head_changed" | "base_changed" | "head_and_base_changed" | "outside_scope";
  ci: "passed" | "failed" | "pending" | "inconclusive" | "absent" | "conflict";
  /** GitHub review observations do not establish independent Factory clearance. */
  review: "absent" | "stale_head" | "inconclusive" | "blocked" | "conflict";
  /** Coverage of GitHub's latest opinionated reviews from repository writers. */
  reviewCoverage: "complete" | "incomplete" | "unobserved";
  candidate: { kind: "none" };
  mergeCommitOid?: string;
  receipts: FactoryReceiptProjection[];
  /** Stable across unchanged reads. Observation time is excluded. */
  digest: string;
  assessment?: FactoryAssessmentPacket;
}

export interface FactoryProjectProjection {
  projectKey: string;
  repository: { host: "github.com"; id?: string; owner: string; name: string };
  authority: { source: "local_owner_github" | "local_owner_git"; observedAt: number };
  /** Bounded newest-open-PR snapshot. One row never triggers another read. */
  inventory: "observed" | "unobserved";
  pullRequests: FactoryProjectPullRequest[];
  truncated: boolean;
  selected?: { kind: "observed"; evidence: FactoryEvidenceSnapshot } | { kind: "absent" };
  candidate?: FactoryBranchProjection;
}

export interface FactoryBranchProjection {
  /** Derived from the immutable issue anchor. Publication never rekeys the row. */
  outcomeId: string;
  workItem: FactoryWorkItem;
  /** Preserved for existing Linear callers. */
  issue?: { provider: "linear"; id: string; source: "local_operator" };
  authority: { source: "local_owner_git"; runtimeInstanceId: string; profile: string; observedAt: number };
  branch: string;
  baseRef: string;
  worktree?: string;
  stage: "branch" | "parked" | "published";
  publication: "unobserved" | "confirmed" | "revision_changed" | "mismatch";
  headOid?: string;
  baseOid?: string;
  receipts: FactoryReceiptProjection[];
  assessment?: FactoryAssessmentPacket;
}
