import { createHash } from "node:crypto";
import type {
  FactoryAssessmentPacket, FactoryEvidenceSnapshot, FactoryProjectPullRequest, FactoryReceiptProjection, FactoryReceiptStatus,
} from "@pwragent/shared/factory-projection";

type Revision = NonNullable<FactoryEvidenceSnapshot["revision"]>;

export interface FactoryEvidenceInput {
  repositoryId: string;
  pullRequest: FactoryProjectPullRequest;
  revision?: Revision;
  expected?: Revision;
  requiredChecks: readonly string[];
  checks: readonly FactoryReceiptProjection[];
  checkContextsComplete: boolean;
  checksTruncated: boolean;
  checkRollup?: string;
  workflowsPending?: boolean;
  reviews: readonly FactoryReceiptProjection[];
  reviewCoverage: FactoryEvidenceSnapshot["reviewCoverage"];
  mergeCommitOid?: string;
  cache?: FactoryReceiptProjection;
  assessment?: { outcome: string; change: string };
}

function revisionState({ pullRequest, revision, expected }: FactoryEvidenceInput): FactoryEvidenceSnapshot["revisionState"] {
  if (!pullRequest.firstParty) return "outside_scope";
  if (!revision) return "absent";
  if (!expected) return "current";
  const headChanged = expected.headOid !== revision.headOid;
  const baseChanged = expected.baseOid !== revision.baseOid;
  if (headChanged && baseChanged) return "head_and_base_changed";
  if (headChanged) return "head_changed";
  return baseChanged ? "base_changed" : "current";
}

function checkVerdict(input: FactoryEvidenceInput, receipts: FactoryReceiptProjection[]): FactoryEvidenceSnapshot["ci"] {
  const requiredNames = new Set(input.requiredChecks);
  const byName = new Map<string, FactoryReceiptStatus>();
  for (const check of input.checks) {
    const previous = byName.get(check.name);
    byName.set(check.name, previous === undefined || previous === check.status ? check.status : "conflict");
    receipts.push({ ...check, required: requiredNames.has(check.name) });
  }
  for (const [name, status] of byName) {
    if (status === "conflict") receipts.push({ kind: "test", name, source: "github", status, required: requiredNames.has(name), headOid: input.revision?.headOid });
  }
  const required = input.requiredChecks.map((name) => {
    const observed = byName.get(name);
    if (observed !== undefined) return observed;
    const status = input.checkContextsComplete ? "absent" : "inconclusive";
    receipts.push({ kind: "test", name, source: "github", status, required: true, headOid: input.revision?.headOid });
    return status;
  });
  const statuses = [...byName.values()];
  if (statuses.includes("conflict") || input.cache?.status === "conflict") return "conflict";
  if (statuses.includes("failed") || input.checkRollup === "FAILURE" || input.checkRollup === "ERROR") return "failed";
  if (input.workflowsPending || statuses.includes("pending") || input.checkRollup === "PENDING" || input.checkRollup === "EXPECTED") return "pending";
  if (!statuses.length && input.checkContextsComplete) return "absent";
  return !input.checksTruncated && input.checkRollup === "SUCCESS" && required.length > 0
    && required.every((status) => status === "current") ? "passed" : "inconclusive";
}

function reviewVerdict(reviews: readonly FactoryReceiptProjection[], complete: boolean): FactoryEvidenceSnapshot["review"] {
  const blocked = reviews.some(({ status }) => status === "failed");
  const inconclusive = reviews.some(({ status }) => status === "inconclusive");
  if (blocked && inconclusive) return "conflict";
  if (blocked) return "blocked";
  if (inconclusive || !complete) return "inconclusive";
  return reviews.some(({ status }) => status === "stale_head") ? "stale_head" : "absent";
}

/** Strictly observational. A head check never supplies a tested merge candidate. */
export function deriveFactoryEvidence(input: FactoryEvidenceInput): FactoryEvidenceSnapshot {
  const state = revisionState(input);
  const usable = state !== "outside_scope" && input.revision !== undefined;
  const receipts = usable ? [...input.reviews] : [];
  if (input.cache && usable) receipts.push(input.cache);
  const ci = usable ? checkVerdict(input, receipts) : "absent";
  const reviewCoverage = usable ? input.reviewCoverage : "unobserved";
  const review = usable ? reviewVerdict(input.reviews, reviewCoverage === "complete") : "absent";
  receipts.push({
    kind: "integration", name: "Merge candidate", source: "github", status: "absent",
    ...input.revision,
  });
  const ordered = receipts.map((receipt) => ({ receipt, key: JSON.stringify(receipt) }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    .map(({ receipt }) => receipt);
  const facts = {
    pullRequest: input.pullRequest, revision: input.revision, revisionState: state, ci, review, reviewCoverage,
    candidate: { kind: "none" } as const, mergeCommitOid: input.mergeCommitOid, receipts: ordered,
  };
  const digest = createHash("sha256").update(JSON.stringify([input.repositoryId, facts])).digest("hex");
  const revision = input.revision;
  if (!input.assessment || !revision || state !== "current") return { ...facts, digest };
  const subject = { headSha: revision.headOid, reference: input.pullRequest.url };
  const evidence: FactoryAssessmentPacket["evidence"] = [
    { ...subject, kind: "test", observation: `Owner CI verdict: ${ci}.` },
    {
      ...subject, kind: "review",
      observation: `Owner review verdict: ${review}. GitHub review coverage is ${reviewCoverage}. Independent clearance is unverified.`,
    },
    { ...subject, kind: "integration", baseSha: revision.baseOid, observation: "No tested merge candidate was observed for this revision pair." },
  ];
  for (const receipt of ordered) {
    if (evidence.length === 64) break;
    if (receipt.kind === "test" && receipt.headOid === revision.headOid && receipt.reference) {
      evidence.push({
        ...subject, kind: "test", reference: receipt.reference,
        observation: `GitHub check ${receipt.name}: ${receipt.status}.`,
      });
    }
  }
  return {
    ...facts, digest,
    assessment: {
      pullRequest: input.pullRequest.url, headSha: revision.headOid, baseSha: revision.baseOid,
      ...input.assessment, evidence,
    },
  };
}
