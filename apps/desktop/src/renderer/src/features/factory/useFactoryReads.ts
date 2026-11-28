import { useRef, useState } from "react";
import type {
  FactoryBranchSelection, FactoryEvidenceSnapshot, FactoryProjectProjection, FactoryProjectReadRequest,
} from "@pwragent/shared/factory-projection";
import type { FactoryScope } from "./FactoryProjectForm";
import type { FactoryBranchRow, FactoryRevision } from "./factory-board";

type BranchRead = FactoryBranchRow & { request: FactoryBranchSelection };
type PrRead = {
  evidence?: FactoryEvidenceSnapshot;
  unavailable?: "missing" | "mismatch";
  expected?: FactoryRevision;
  checks: string[];
};
type Repository = FactoryProjectProjection["repository"];
type BoardRead = {
  scope: FactoryScope;
  repository: Repository;
  inventory?: FactoryProjectProjection;
  branch?: BranchRead;
  details: Map<number, PrRead>;
};
type ReadProject = (request: FactoryProjectReadRequest) => Promise<FactoryProjectProjection>;

function sameScope(left: FactoryScope, right: FactoryScope): boolean {
  return left.projectKey === right.projectKey && left.repository.toLowerCase() === right.repository.toLowerCase();
}

function sameRepository(left: Repository, right: Repository): boolean {
  return left.host === right.host && left.owner.toLowerCase() === right.owner.toLowerCase()
    && left.name.toLowerCase() === right.name.toLowerCase()
    && (!left.id || !right.id || left.id === right.id);
}

function forRepository(current: BoardRead | undefined, scope: FactoryScope, repository: Repository): BoardRead {
  if (!current || !sameScope(current.scope, scope) || !sameRepository(current.repository, repository)) {
    return { scope, repository, details: new Map() };
  }
  return { ...current, repository: { ...repository, id: repository.id ?? current.repository.id } };
}

function sameBranchSubject(previous: FactoryBranchRow | undefined, next: FactoryBranchRow["branch"]): boolean {
  const branch = previous?.branch;
  return !!branch && branch.outcomeId === next.outcomeId && branch.branch === next.branch && branch.baseRef === next.baseRef
    && branch.authority.runtimeInstanceId === next.authority.runtimeInstanceId && branch.authority.profile === next.authority.profile
    && branch.headOid === next.headOid && branch.baseOid === next.baseOid;
}

/** Keep cached reads bounded by the current inventory page plus an explicit selection. */
function detailsForInventory(previous: Map<number, PrRead>, result: FactoryProjectProjection): Map<number, PrRead> {
  const details = new Map<number, PrRead>();
  for (const pr of result.pullRequests) {
    const prior = previous.get(pr.number);
    if (prior?.evidence?.pullRequest.firstParty === pr.firstParty) details.set(pr.number, prior);
  }
  return details;
}

export function useFactoryReads(read: ReadProject) {
  const [board, setBoard] = useState<BoardRead>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);

  async function request(
    args: FactoryProjectReadRequest,
    decorate: (before: BoardRead, result: FactoryProjectProjection) => BoardRead,
  ): Promise<void> {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    const scope = { projectKey: args.projectKey, repository: args.repository };
    try {
      const result = await read(args);
      setBoard((current) => decorate(forRepository(current, scope, result.repository), result));
    } catch (error) {
      // The selected read can fail if the owner can no longer verify the old repository ID.
      // Keep the last inventory as history, and require a fresh observation for details.
      if (args.selection) setBoard((current) => current && sameScope(current.scope, scope)
        ? {
          ...current, details: new Map(),
          branch: current.branch && { ...current.branch, linked: undefined, compared: undefined },
        }
        : current);
      setError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : "Could not read Factory evidence.");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  function readScope(scope: FactoryScope, candidate?: FactoryBranchSelection) {
    return request({ ...scope, candidate }, (before, result) => {
      const branch = result.candidate;
      const previous = before.branch;
      if (candidate && branch) {
        const linked = sameBranchSubject(previous, branch) ? previous?.linked : undefined;
        const details = new Map(before.details);
        if (!linked && previous?.linked) details.delete(previous.linked.pullRequest.number);
        return { ...before, details, branch: { key: branch.outcomeId, branch, request: candidate, linked } };
      }
      const details = detailsForInventory(before.details, result);
      const linked = previous?.linked;
      const hasLinkedPr = linked && result.pullRequests.some((pr) => pr.number === linked.pullRequest.number && pr.firstParty);
      return {
        ...before, inventory: result, details,
        branch: previous && { ...previous, linked: hasLinkedPr ? linked : undefined },
      };
    });
  }

  function readPr(number: number, compare: boolean, checks?: string[]) {
    const repositoryId = board?.inventory?.repository.id;
    if (!board || !repositoryId) return;
    const before = board.details.get(number);
    const local = board.branch;
    const bound = local && (compare || local.linked?.pullRequest.number === number) ? local : undefined;
    const { headOid, baseOid } = bound?.branch ?? {};
    const expectedBranch = headOid && baseOid ? { headOid, baseOid } : undefined;
    const expected = (compare ? expectedBranch : before?.expected) ?? expectedBranch;
    const requiredChecks = checks ?? before?.checks ?? [];
    return request({
      ...board.scope,
      candidate: bound?.request,
      selection: { repositoryId, number, expected, requiredChecks },
    }, (current, result) => {
      const observed = result.selected?.kind === "observed" ? result.selected.evidence : undefined;
      const details = detailsForInventory(current.details, result);
      let branch = current.branch;
      const linked = branch?.linked;
      if (branch && linked && result.pullRequests.some((pr) => pr.number === linked.pullRequest.number && !pr.firstParty)) {
        branch = { ...branch, linked: undefined };
      }
      if (bound && result.candidate) {
        const candidate = result.candidate;
        if (branch?.linked && !sameBranchSubject(branch, candidate)) details.delete(branch.linked.pullRequest.number);
        branch = {
          key: candidate.outcomeId, branch: candidate, request: bound.request,
          linked: candidate.publication === "confirmed" ? observed : undefined,
          compared: candidate.publication === "revision_changed" ? observed?.revision : undefined,
        };
      }
      details.set(number, {
        evidence: observed, expected: expected ?? observed?.revision, checks: requiredChecks,
        unavailable: observed ? undefined : result.candidate?.publication === "mismatch" ? "mismatch" : "missing",
      });
      return { ...current, inventory: result, branch, details };
    });
  }

  return { board, pending, error, readScope, readPr };
}
