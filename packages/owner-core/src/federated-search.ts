import type { AppServerBackendKind, AppServerListThreadsResponse, AppServerThreadSummary,
  FederatedSearchRequest, FederationThreadSearchRequest, FederationThreadSearchResponse } from "@pwragent/shared";
import { buildThreadIdentityKey, parseThreadSearchQuery, threadSearchTextTerms, matchesThreadSearchProjects } from "@pwragent/shared";

function searchLimit(limit: number | undefined): number {
  return Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit!), 200)) : 50;
}

export async function searchFederatedThreadsOnOwner(
  backendOperations: { listThreads(request: { backend?: AppServerBackendKind; archived?: boolean }, options?: { deadlineAt?: number }): Promise<AppServerListThreadsResponse> },
  request: FederationThreadSearchRequest,
  rpcOptions?: { deadlineAt?: number },
): Promise<FederationThreadSearchResponse> {
  const limit = searchLimit(request.limit);
  const { query, projects } = parseThreadSearchQuery(request.query);
  const threads = await listFederatedSearchThreads(
    backendOperations,
    request,
    rpcOptions,
  );
  const text = threadSearchTextTerms(query).map((term) => term.text).join(" ");
  const exact = looksLikeExactThreadId(text);
  const normalized = text.toLowerCase();
  const matches = threads
    .filter((thread) => matchesThreadSearchProjects(thread, projects))
    .filter((thread) => exact
      ? thread.id.toLowerCase() === normalized
      : !query || scoreThread(thread, query) > 0 || thread.id.toLowerCase().includes(normalized));
  matches.sort(compareFederatedSearchThreads(query));
  checkSearchDeadline(rpcOptions);
  return {
    threads: matches.slice(0, limit),
    totalCount: matches.length,
    truncated: matches.length > limit,
  };
}

async function listFederatedSearchThreads(
  backendOperations: { listThreads(request: { backend?: AppServerBackendKind; archived?: boolean }, options?: { deadlineAt?: number }): Promise<AppServerListThreadsResponse> },
  request: FederatedSearchRequest,
  rpcOptions?: { deadlineAt?: number },
): Promise<AppServerThreadSummary[]> {
  const list = async (archived: boolean) => {
    checkSearchDeadline(rpcOptions);
    const listRequest = {
      backend: request.backend === "all" ? undefined : request.backend,
      archived,
    };
    return rpcOptions
      ? await backendOperations.listThreads(listRequest, rpcOptions)
      : await backendOperations.listThreads(listRequest);
  };
  const responses: AppServerListThreadsResponse[] = [await list(false)];
  if (request.includeArchived) {
    responses.push(await list(true));
  }
  const byIdentity = new Map<string, AppServerThreadSummary>();
  // Active membership wins if an old provider reports the same row in both lists.
  for (const thread of responses.slice().reverse().flatMap((response) => response.threads)) {
    byIdentity.set(buildThreadIdentityKey(thread.source, thread.id), thread);
  }
  return [...byIdentity.values()].filter((thread) => matchesFederatedSearchFilters(thread, request));
}

function checkSearchDeadline(options?: { deadlineAt?: number }): void {
  if (options?.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
    throw new Error("Federated search deadline expired.");
  }
}

function matchesFederatedSearchFilters(
  thread: AppServerThreadSummary,
  request: FederatedSearchRequest,
): boolean {
  if (
    request.backend
    && request.backend !== "all"
    && thread.source !== request.backend
  ) {
    return false;
  }
  if (
    request.projectKeys?.length
    && (!thread.projectKey || !request.projectKeys.includes(thread.projectKey))
  ) {
    return false;
  }
  const updatedAt = thread.updatedAt ?? thread.createdAt ?? 0;
  if (request.updatedAfter !== undefined && updatedAt < request.updatedAfter) {
    return false;
  }
  if (request.updatedBefore !== undefined && updatedAt > request.updatedBefore) {
    return false;
  }
  return true;
}

function looksLikeExactThreadId(query: string): boolean {
  return (
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(query)
    || /^session_[0-9a-z_-]{10,}$/i.test(query)
  );
}

export function scoreThread(thread: AppServerThreadSummary, query: string): number {
  query = threadSearchTextTerms(parseThreadSearchQuery(query).query)
    .map((term) => term.text).join(" ");
  if (!query) return 0;
  const normalized = query.toLowerCase();
  const title = thread.title.toLowerCase();
  const summary = thread.summary?.toLowerCase() ?? "";
  const directories = thread.linkedDirectories
    .map((directory) => `${directory.label} ${directory.path} ${directory.worktreePath ?? ""}`)
    .join(" ")
    .toLowerCase();
  let score = 0;
  if (title === normalized) score += 1_000;
  if (title.startsWith(normalized)) score += 500;
  if (title.includes(normalized)) score += 250;
  if (summary.includes(normalized)) score += 100;
  if (directories.includes(normalized)) score += 50;
  if (thread.projectKey?.toLowerCase().includes(normalized)) score += 50;
  return score;
}

function compareFederatedSearchThreads(query: string) {
  return (
    left: AppServerThreadSummary,
    right: AppServerThreadSummary,
  ): number => {
    const scoreDifference = scoreThread(right, query) - scoreThread(left, query);
    if (scoreDifference !== 0) return scoreDifference;
    return (
      (right.updatedAt ?? right.createdAt ?? 0)
      - (left.updatedAt ?? left.createdAt ?? 0)
    );
  };
}
