import { z } from "zod";
import { factoryWorkItemKey, parseFactoryWorkItem } from "@pwragent/shared/factory-work-item";
import type { DesktopFederationRuntime } from "../federation/federation-runtime";
import { createFactoryAdmissionStorage } from "../storage/factory-admission-storage";
import { isFactoryBranchName, isFactoryIntegrationRef, readFactoryCleanCandidate } from "./factory-branch-evidence";
import { approvalWorkItem, localFactoryOwner, registeredFactoryProject, sameFactoryOwner } from "./factory-local-authority";
import {
  createFactoryScalingReceipt, factoryScalingReceiptId, factoryScalingReceiptPath, factoryScalingReport,
  factoryScalingRevision, factoryScalingStatus, matchesFactoryScalingSubject, readFactoryScalingReceipt, writeFactoryScalingReceipt,
} from "./factory-scaling-receipt";

const subject = {
  projectKey: z.string().max(4096).startsWith("directory:"),
  repository: z.string().regex(/^[a-z0-9-]{1,39}\/[a-z0-9_.-]{1,100}$/i).toLowerCase(),
  approvalId: z.uuid(),
  candidate: z.strictObject({
    issueId: z.unknown().optional(),
    workItem: z.unknown().optional(),
    branch: z.string().max(255).refine(isFactoryBranchName, "Select a local candidate branch."),
    baseRef: z.string().max(255).refine(isFactoryIntegrationRef, "Select a full local or remote-tracking integration ref."),
  }),
};
const request = z.discriminatedUnion("action", [
  z.strictObject({ ...subject, action: z.literal("status") }),
  z.strictObject({ ...subject, action: z.literal("record"), expected: factoryScalingRevision,
    previousReceiptId: factoryScalingReceiptId.nullable(), report: factoryScalingReport }),
]);

export function createOwnerFactoryScaling(options: { federation: DesktopFederationRuntime; leaseHeld(): boolean }) {
  const admission = createFactoryAdmissionStorage();
  const owner = () => localFactoryOwner(options.federation, () => options.leaseHeld());
  return async (params: unknown) => {
    const input = request.parse(params);
    const { projectKey, repository, approvalId, candidate: selection } = input;
    const { branch, baseRef } = selection;
    const workItem = parseFactoryWorkItem(selection);
    const outcomeId = factoryWorkItemKey(workItem);
    if (baseRef === `refs/heads/${branch}`) throw new Error("Select an integration ref distinct from the candidate branch.");
    const row = admission.readByApprovalId(approvalId);
    if (!row || row.projectKey !== projectKey || row.repository !== repository || factoryWorkItemKey(approvalWorkItem(row)) !== outcomeId) {
      throw new Error("Select the exact Factory approval, issue and repository.");
    }
    if (!sameFactoryOwner(owner(), row.owner)) throw new Error("Factory requires the selected local Federation owner.");
    if (!sameFactoryOwner(row.owner, row.target)) throw new Error("Scaling evidence requires the approved worktree on the local owner.");
    const worktree = row.target.worktreePath;
    const project = await registeredFactoryProject(projectKey);
    const candidate = project ? await readFactoryCleanCandidate(project, repository, selection, worktree) : { state: "unverified" } as const;
    if (!sameFactoryOwner(owner(), row.owner)) throw new Error("Factory lost the selected local Federation owner.");

    // The local owner lease fences this synchronous read/compare/replace, including across restarts.
    const file = factoryScalingReceiptPath(approvalId);
    let receipt = readFactoryScalingReceipt(file);
    const binding = { approvalId, repository, projectKey };
    if (receipt && !matchesFactoryScalingSubject(receipt, { ...binding, workItem, worktree })) {
      throw new Error("Factory scaling receipt does not match the approved outcome.");
    }
    if (input.action === "record") {
      if (candidate.state !== "clean" || candidate.headOid !== input.expected.headOid || candidate.baseOid !== input.expected.baseOid) {
        throw new Error("The approved worktree must be clean at the reported head and integration base.");
      }
      const next = createFactoryScalingReceipt({
        // Keep existing Linear receipt IDs and exact replays stable across upgrades.
        ...(workItem.provider === "linear"
          ? { version: 1, source: "operator_attested", ...binding, issueId: workItem.id } as const
          : { version: 2, source: "operator_attested", ...binding, workItem } as const),
        worktree, branch, baseRef,
        revision: { headOid: candidate.headOid, baseOid: candidate.baseOid },
        previousReceiptId: input.previousReceiptId, report: input.report,
      });
      if (receipt?.receiptId !== next.receiptId) {
        if ((receipt?.receiptId ?? null) !== input.previousReceiptId) throw new Error("Factory scaling receipt changed. Read its status before recording a new audit.");
        writeFactoryScalingReceipt(file, next);
        receipt = next;
      }
    }
    return {
      outcomeId, ...binding, workItem, ...(workItem.provider === "linear" ? { issueId: workItem.id } : {}),
      worktree, branch, baseRef, candidate: { ...candidate, source: "local_owner_git" as const },
      status: factoryScalingStatus(receipt, candidate, branch, baseRef),
      receipt: receipt && { ...receipt, artifactPath: file },
    };
  };
}
