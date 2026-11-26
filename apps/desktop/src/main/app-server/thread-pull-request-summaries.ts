import { type PrSummary } from "@pwragent/shared/contracts/navigation";
import {
  buildPullRequestStatusKey,
  resolvePullRequestIdentity,
  normalizePullRequestProvider as normalizeSharedPullRequestProvider,
} from "@pwragent/shared/contracts/navigation";

export function normalizePrLookupDirectoryPaths(directoryPaths: string[]): string[] {
  return [...new Set(directoryPaths.map((path) => path.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

export function normalizePullRequestProvider(provider: string | undefined): string {
  return normalizeSharedPullRequestProvider(provider);
}

export function normalizePrSummary(pr: PrSummary): PrSummary {
  const checkState = normalizePrCheckState(pr.checkState ?? pr.state);
  const headSha = normalizeCommitShas(
    pr.headSha ? [pr.headSha] : undefined,
  )?.[0];
  const normalized: PrSummary = {
    ...pr,
    ...resolvePullRequestIdentity(pr),
    state: checkState,
    checkState,
    lifecycleState: pr.lifecycleState ?? legacyPrLifecycleState(pr.state),
    reviewState: pr.reviewState ?? legacyPrReviewState(pr.state),
    mergeState: pr.mergeState ?? "unknown",
    commitShas: normalizeCommitShas(pr.commitShas),
  };
  if (headSha) {
    normalized.headSha = headSha;
  } else {
    delete normalized.headSha;
  }
  const baseRefName = pr.baseRefName?.trim();
  if (baseRefName) {
    normalized.baseRefName = baseRefName;
  } else {
    delete normalized.baseRefName;
  }
  const headRefName = pr.headRefName?.trim();
  if (headRefName) {
    normalized.headRefName = headRefName;
  } else {
    delete normalized.headRefName;
  }
  const linkedDirectoryPaths = normalizePrLookupDirectoryPaths(
    pr.linkedDirectoryPaths ?? [],
  );
  if (linkedDirectoryPaths.length > 0) {
    normalized.linkedDirectoryPaths = linkedDirectoryPaths;
  } else {
    delete normalized.linkedDirectoryPaths;
  }
  return normalized;
}

export function mergeLinkedDirectoryPaths(
  left: string[] | undefined,
  right: string[] | undefined,
): string[] | undefined {
  const merged = normalizePrLookupDirectoryPaths([
    ...(left ?? []),
    ...(right ?? []),
  ]);
  return merged.length > 0 ? merged : undefined;
}

export function associatePrsWithLinkedDirectories(
  prs: PrSummary[],
  directoryPaths: string[],
): PrSummary[] {
  const linkedDirectoryPaths = normalizePrLookupDirectoryPaths(directoryPaths);
  return prs.map((pr) => {
    if (!pr.headSha?.trim()) {
      return pr;
    }
    const discoveredDirectoryPaths = normalizePrLookupDirectoryPaths(
      pr.linkedDirectoryPaths ?? [],
    );
    // Discovery records which checkout returned each PR. A multi-repository
    // lookup cannot safely use every requested path as a fallback: doing so
    // makes a PR from one repository appear to constrain all sibling repos.
    const associatedDirectoryPaths = discoveredDirectoryPaths.length > 0
      ? discoveredDirectoryPaths
      : linkedDirectoryPaths.length === 1
        ? linkedDirectoryPaths
        : [];
    return normalizePrSummary({
      ...pr,
      linkedDirectoryPaths: associatedDirectoryPaths,
    });
  });
}

export function stripPrLinkedDirectoryPaths(pr: PrSummary): PrSummary {
  const normalized = normalizePrSummary(pr);
  delete normalized.linkedDirectoryPaths;
  delete normalized.explicitlyAttached;
  delete normalized.autoFixOff;
  return normalized;
}

function normalizeCommitShas(commitShas: string[] | undefined): string[] | undefined {
  const normalized = [
    ...new Set(
      (commitShas ?? [])
        .map((sha) => sha.trim().toLowerCase())
        .filter((sha) => /^[0-9a-f]{40}$/.test(sha)),
    ),
  ].sort();
  return normalized.length > 0 ? normalized : undefined;
}

export function dedupePrsByStatusKey(prs: PrSummary[]): PrSummary[] {
  const seen = new Set<string>();
  const out: PrSummary[] = [];
  for (const pr of prs.map(normalizePrSummary)) {
    const key = getPrStatusKey(pr);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(pr);
  }
  return out;
}

function normalizePrCheckState(
  state: string | undefined,
): NonNullable<PrSummary["checkState"]> {
  if (
    state === "passing"
    || state === "failing"
    || state === "pending"
    || state === "unknown"
  ) {
    return state;
  }
  return "unknown";
}

function legacyPrLifecycleState(state: string | undefined): PrSummary["lifecycleState"] {
  if (state === "merged" || state === "closed") {
    return state;
  }
  return "open";
}

function legacyPrReviewState(state: string | undefined): PrSummary["reviewState"] {
  return state === "draft" ? "draft" : "ready_for_review";
}

export function getPrStatusKey(
  pr: Pick<PrSummary, "provider" | "org" | "repo" | "number"> & { url?: string },
): string {
  return buildPullRequestStatusKey(pr);
}

/**
 * Whether two PR lists are the same for snapshot purposes.
 *
 * This decides whether a navigation snapshot is republished, so a field that
 * clients render or the main process reads for behavior but this function
 * ignores becomes a silent staleness bug: the value moves, the snapshot is
 * judged unchanged, and no window ever hears about it. Add every such field
 * here. Exported for the test that pins exactly that.
 */
export function prSummariesEqual(left: PrSummary[], right: PrSummary[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((pr, index) => {
    const candidate = right[index];
    return (
      candidate?.number === pr.number &&
      normalizePullRequestProvider(candidate.provider)
        === normalizePullRequestProvider(pr.provider) &&
      candidate.org === pr.org &&
      candidate.repo === pr.repo &&
      candidate.sourceRepository?.provider === pr.sourceRepository?.provider &&
      candidate.sourceRepository?.org === pr.sourceRepository?.org &&
      candidate.sourceRepository?.repo === pr.sourceRepository?.repo &&
      candidate.title === pr.title &&
      JSON.stringify(candidate.labels ?? null) === JSON.stringify(pr.labels ?? null) &&
      candidate.state === pr.state &&
      candidate.checkState === pr.checkState &&
      candidate.checksStillRunning === pr.checksStillRunning &&
      candidate.checksAllSkipped === pr.checksAllSkipped &&
      candidate.lifecycleState === pr.lifecycleState &&
      candidate.reviewState === pr.reviewState &&
      candidate.mergeState === pr.mergeState &&
      JSON.stringify(candidate.mergeQueue ?? null) === JSON.stringify(pr.mergeQueue ?? null) &&
      JSON.stringify(candidate.allowedMergeMethods ?? null)
        === JSON.stringify(pr.allowedMergeMethods ?? null) &&
      JSON.stringify(candidate.githubStack ?? null) === JSON.stringify(pr.githubStack ?? null) &&
      candidate.baseRefName === pr.baseRefName &&
      candidate.headRefName === pr.headRefName &&
      candidate.headSha === pr.headSha &&
      JSON.stringify(candidate.linkedDirectoryPaths ?? [])
        === JSON.stringify(pr.linkedDirectoryPaths ?? []) &&
      candidate.explicitlyAttached === pr.explicitlyAttached &&
      candidate.autoFixOff === pr.autoFixOff &&
      JSON.stringify(candidate.commitShas ?? []) === JSON.stringify(pr.commitShas ?? []) &&
      // Hover-card fields. They belong here for the same reason as every field
      // above: this comparison decides whether a snapshot is republished, so a
      // poll whose only movement is "+412 → +530" must not be judged unchanged.
      candidate.additions === pr.additions &&
      candidate.deletions === pr.deletions &&
      candidate.changedFiles === pr.changedFiles &&
      candidate.commitCount === pr.commitCount &&
      candidate.createdAt === pr.createdAt &&
      candidate.mergedAt === pr.mergedAt &&
      candidate.closedAt === pr.closedAt &&
      candidate.url === pr.url
    );
  });
}

export function prLogIds(prs: PrSummary[]): string[] {
  return prs.map((pr) => getPrStatusKey(pr));
}

export function prLogStatuses(prs: PrSummary[]): Record<string, unknown>[] {
  return prs.map((pr) => {
    const normalized = normalizePrSummary(pr);
    return {
      prKey: getPrStatusKey(normalized),
      checkState: normalized.checkState,
      checksStillRunning: normalized.checksStillRunning ?? false,
      lifecycleState: normalized.lifecycleState,
      mergeState: normalized.mergeState,
      reviewState: normalized.reviewState,
      commitCount: normalized.commitShas?.length ?? 0,
    };
  });
}
