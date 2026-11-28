import type {
  FactoryBranchProjection, FactoryEvidenceSnapshot, FactoryProjectProjection,
  FactoryProjectPullRequest, FactoryReceiptStatus,
} from "@pwragent/shared/factory-projection";
import type { FactoryWorkItem } from "@pwragent/shared/factory-work-item";

export function trackingLabel(item: FactoryWorkItem): string {
  switch (item.provider) {
    case "linear": return "Linear issue";
    case "jira": return "Jira issue";
    case "github": return item.kind === "issue" ? "GitHub issue" : "GitHub pull request";
  }
}

export const FACTORY_LANES = ["Needs you", "Now", "Next", "Paused"] as const;
export type FactoryLane = (typeof FACTORY_LANES)[number];
export type FactoryRevision = NonNullable<FactoryEvidenceSnapshot["revision"]>;

type FactoryStatus = { lane: FactoryLane; reason: string };

export function revisionNotice(state: FactoryEvidenceSnapshot["revisionState"]): string {
  switch (state) {
    case "current": return "";
    case "head_changed": return "The PR head changed. Review and test evidence must be checked against the new head.";
    case "base_changed": return "The target base changed. Integration evidence is needed for the new base.";
    case "head_and_base_changed": return "The PR head and target base changed. Review and integration evidence need updating.";
    case "outside_scope": return "The PR head comes from a different repository.";
    case "absent": return "GitHub did not confirm the head and base.";
  }
}

export function prStatus(pr: FactoryProjectPullRequest, evidence?: FactoryEvidenceSnapshot): FactoryStatus {
  if (!pr.firstParty) return { lane: "Paused", reason: "Head is outside the selected repository" };
  if (pr.lifecycle !== "open") return { lane: "Paused", reason: pr.lifecycle === "merged" ? "Merged on GitHub" : "Closed on GitHub" };
  if (pr.draft) return { lane: "Paused", reason: "Draft pull request" };
  if (!evidence) return { lane: "Next", reason: "Open to read evidence" };
  if (evidence.ci === "conflict" || evidence.review === "conflict") return { lane: "Needs you", reason: "Evidence conflicts" };
  if (evidence.ci === "failed") return { lane: "Needs you", reason: "Checks failed" };
  if (evidence.review === "blocked") return { lane: "Needs you", reason: "Review reported blockers" };
  if (evidence.revisionState !== "current") return { lane: "Needs you", reason: revisionNotice(evidence.revisionState) };
  if (evidence.review === "stale_head") return { lane: "Needs you", reason: "Review refers to an earlier head" };
  if (evidence.ci === "pending") return { lane: "Now", reason: "Checks in progress" };
  return { lane: "Next", reason: "Landing evidence incomplete" };
}

function branchStatus({ branch, compared }: FactoryBranchRow): FactoryStatus {
  if (branch.publication === "mismatch") return { lane: "Needs you", reason: "This PR does not match the local branch and target" };
  if (branch.publication === "revision_changed") {
    let reason = "Publication could not be verified for the current revisions";
    if (compared && branch.headOid && branch.baseOid) {
      if (compared.headOid === branch.headOid && compared.baseOid !== branch.baseOid) {
        reason = "The local and published target bases differ";
      } else if (compared.headOid !== branch.headOid) {
        reason = compared.baseOid === branch.baseOid
          ? "The local and published heads differ"
          : "The local and published heads and target bases differ";
      }
    }
    return { lane: "Needs you", reason };
  }
  if (!branch.headOid || !branch.baseOid) return { lane: "Paused", reason: "Local head or base could not be resolved" };
  if (branch.receipts.some((receipt) => receipt.status === "failed" || receipt.status === "conflict")) {
    return { lane: "Needs you", reason: "Local review evidence needs attention" };
  }
  const stale = branch.receipts.find((receipt) => receipt.status === "stale_head" || receipt.status === "stale_base");
  if (stale) return {
    lane: "Needs you",
    reason: stale.status === "stale_head" ? "Review refers to an earlier head" : "Review refers to an earlier base",
  };
  if (branch.stage === "parked") return { lane: "Paused", reason: "Branch has no verified active worktree" };
  return { lane: "Next", reason: "Local branch and target observed" };
}

export type FactoryBranchRow = {
  key: string;
  branch: FactoryBranchProjection;
  linked?: FactoryEvidenceSnapshot;
  compared?: FactoryRevision;
};

export type FactoryRow = FactoryStatus & {
  key: string;
  branch?: FactoryBranchProjection;
  compared?: FactoryRevision;
  pr?: FactoryProjectPullRequest;
  title: string;
  context: string;
};

export function factoryRows(
  project: FactoryProjectProjection | undefined,
  local: FactoryBranchRow | undefined,
  evidence: ReadonlyMap<number, FactoryEvidenceSnapshot>,
): FactoryRow[] {
  const linked = local?.linked;
  const inventory = new Map(project?.pullRequests.map((pr) => [pr.number, pr]));
  for (const [number, detail] of evidence) {
    if (!inventory.has(number) || detail.pullRequest.lifecycle !== "open") inventory.set(number, detail.pullRequest);
  }
  const published = linked && (inventory.get(linked.pullRequest.number) ?? linked.pullRequest);
  const rows = [...inventory.values()].flatMap((pr) => {
    if (pr.number === published?.number) return [];
    const observed = evidence.get(pr.number);
    return [{
      key: `github:${project?.repository.id}:${pr.number}`,
      title: pr.title || `Pull request #${pr.number}`,
      context: `#${pr.number} · Pull request`,
      pr,
      ...prStatus(pr, observed),
    }];
  });
  if (!local) return rows;
  const localStatus = branchStatus(local);
  let status = published ? prStatus(published, linked) : localStatus;
  if (localStatus.lane === "Needs you" && (status.lane === "Now" || status.lane === "Next")) {
    status = localStatus;
  }
  return [{
    key: local.key,
    title: published?.title || local.branch.branch,
    context: published ? `#${published.number} · ${trackingLabel(local.branch.workItem)}` : `${trackingLabel(local.branch.workItem)} · Local branch`,
    branch: local.branch,
    compared: local.compared,
    pr: published,
    ...status,
  }, ...rows];
}

export const RECEIPT_STATUS: Record<FactoryReceiptStatus, string> = {
  current: "Current",
  absent: "Missing",
  stale_head: "Stale head",
  stale_base: "Stale base",
  stale: "Stale",
  inconclusive: "Inconclusive",
  pending: "Pending",
  failed: "Failed",
  conflict: "Conflicting",
};
