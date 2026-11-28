import { useRef, useState } from "react";
import type {
  FactoryBranchSelection, FactoryEvidenceSnapshot, FactoryProjectProjection, FactoryProjectReadRequest,
} from "@pwragent/shared/factory-projection";
import type { FactoryScope } from "./FactoryProjectForm";
import type { FactoryBranchRow, FactoryRevision } from "./factory-board";

type BranchRead = FactoryBranchRow & { request: FactoryBranchSelection };
type PrInputs = {
  expected?: FactoryRevision;
  checks: string[];
  retryCandidate?: FactoryBranchSelection;
};
type PrRead = Pick<PrInputs, "expected" | "checks"> & {
  evidence?: FactoryEvidenceSnapshot;
  observedAt?: number;
  unavailable?: "missing" | "mismatch";
};
type Repository = FactoryProjectProjection["repository"];
type BoardRead = {
  scope: FactoryScope;
  repository: Repository;
  inventory?: FactoryProjectProjection;
  branch?: BranchRead;
  details: Map<number, PrRead>;
};
type VerifiedInputs = {
  scope: FactoryScope;
  repositoryId: string;
  prs: Map<number, PrInputs>;
};
type ReadProject = (request: FactoryProjectReadRequest) => Promise<FactoryProjectProjection>;

function sameScope(left: FactoryScope, right: FactoryScope): boolean {
  return left.projectKey === right.projectKey && left.repository.toLowerCase() === right.repository.toLowerCase();
}

function forRepository(current: BoardRead | undefined, scope: FactoryScope, repository: Repository): BoardRead {
  const previous = current?.repository;
  if (!current || !previous || !sameScope(current.scope, scope) || previous.host !== repository.host
    || previous.owner.toLowerCase() !== repository.owner.toLowerCase()
    || previous.name.toLowerCase() !== repository.name.toLowerCase()
    || (previous.id && repository.id && previous.id !== repository.id)) {
    return { scope, repository, details: new Map() };
  }
  return { ...current, repository: { ...repository, id: repository.id ?? previous.id } };
}

function sameBranchSubject(previous: FactoryBranchRow | undefined, next: FactoryBranchRow["branch"]): boolean {
  const branch = previous?.branch;
  return !!branch && branch.outcomeId === next.outcomeId && branch.branch === next.branch && branch.baseRef === next.baseRef
    && branch.authority.runtimeInstanceId === next.authority.runtimeInstanceId && branch.authority.profile === next.authority.profile
    && branch.headOid === next.headOid && branch.baseOid === next.baseOid;
}

function withoutPublication(local: BranchRead): BranchRead {
  const branch = local.branch;
  return {
    ...local, linked: undefined, compared: undefined,
    branch: { ...branch, publication: "unobserved" },
  };
}

/** Reconcile the displayed page and linked outcome on every new open inventory. */
function withInventory(previous: BoardRead, inventory: FactoryProjectProjection): BoardRead {
  const details = new Map<number, PrRead>();
  let branch = previous.branch;
  const linked = branch?.linked?.pullRequest;
  let linkedRow: FactoryEvidenceSnapshot["pullRequest"] | undefined;
  for (const pr of inventory.pullRequests) {
    if (pr.number === linked?.number) linkedRow = pr;
    const prior = previous.details.get(pr.number);
    const observed = prior?.evidence?.pullRequest;
    if (prior && observed?.firstParty === pr.firstParty && observed.lifecycle === pr.lifecycle) {
      details.set(pr.number, prior);
    }
  }
  if (branch && linked) {
    const retainLink = linkedRow
      ? linkedRow.firstParty && linked.lifecycle === linkedRow.lifecycle
      : inventory.truncated || linked.lifecycle !== "open";
    if (retainLink) {
      const prior = previous.details.get(linked.number);
      if (prior) details.set(linked.number, prior);
    } else {
      branch = withoutPublication(branch);
    }
  }
  return { ...previous, inventory, branch, details };
}

export function useFactoryReads(read: ReadProject) {
  const [board, setBoard] = useState<BoardRead>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  // Operator inputs are independent of the disposable evidence page. Only explicit
  // PR reads create entries, and a newly verified repository starts with no inputs.
  const verifiedInputs = useRef<VerifiedInputs>(undefined);

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
      const repositoryId = result.inventory === "observed" && result.authority.source === "local_owner_github"
        ? result.repository.id : undefined;
      if (args.selection && args.selection.repositoryId !== repositoryId) {
        throw new Error("The selected project repository could not be confirmed by GitHub.");
      }
      if (repositoryId && (verifiedInputs.current?.repositoryId !== repositoryId
        || !sameScope(verifiedInputs.current.scope, scope))) {
        verifiedInputs.current = { scope, repositoryId, prs: new Map() };
      }
      setBoard(decorate(forRepository(board, scope, result.repository), result));
    } catch (error) {
      // A failed GitHub read cannot revalidate receipts or a publication link.
      if (board && sameScope(board.scope, scope) && (!args.candidate || args.selection)) {
        setBoard({ ...board, details: new Map(), branch: board.branch && withoutPublication(board.branch) });
      }
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
        if (linked || !previous?.linked) {
          return { ...before, branch: { key: branch.outcomeId, branch, request: candidate, linked } };
        }
        const details = new Map(before.details);
        details.delete(previous.linked.pullRequest.number);
        return { ...before, details, branch: { key: branch.outcomeId, branch, request: candidate } };
      }
      return withInventory(before, result);
    });
  }

  function readPr(number: number, compare: boolean, checks?: string[], repositoryId = board?.inventory?.repository.id) {
    if (busy.current || !board || !repositoryId) return;
    const verified = verifiedInputs.current;
    const inputs = board.inventory?.repository.id === repositoryId && verified?.repositoryId === repositoryId
      && sameScope(verified.scope, board.scope) ? verified.prs : undefined;
    const previous = inputs?.get(number);
    const local = board.branch;
    const bound = local && (compare || local.linked?.pullRequest.number === number || previous?.retryCandidate === local.request)
      ? local : undefined;
    const expected = previous?.expected;
    const requiredChecks = checks ?? previous?.checks ?? [];
    inputs?.set(number, { expected, checks: requiredChecks, retryCandidate: bound?.request });

    return request({
      ...board.scope,
      candidate: bound?.request,
      selection: { repositoryId, number, expected, requiredChecks },
    }, (current, result) => {
      const observed = result.selected?.kind === "observed" ? result.selected.evidence : undefined;
      const next = withInventory(current, result);
      const baseline = expected ?? observed?.revision;
      verifiedInputs.current?.prs.set(number, { expected: baseline, checks: requiredChecks });
      next.details.set(number, {
        evidence: observed, observedAt: observed ? result.authority.observedAt : undefined,
        expected: baseline, checks: requiredChecks,
        unavailable: observed ? undefined : result.candidate?.publication === "mismatch" ? "mismatch" : "missing",
      });
      if (bound && result.candidate) {
        const candidate = result.candidate;
        const oldLink = next.branch?.linked?.pullRequest.number;
        if (oldLink !== undefined && oldLink !== number && !sameBranchSubject(next.branch, candidate)) {
          next.details.delete(oldLink);
        }
        next.branch = {
          key: candidate.outcomeId, branch: candidate, request: bound.request,
          linked: candidate.publication === "confirmed" ? observed : undefined,
          compared: candidate.publication === "revision_changed" ? observed?.revision : undefined,
        };
      }
      return next;
    });
  }

  return { board, pending, error, readScope, readPr };
}
