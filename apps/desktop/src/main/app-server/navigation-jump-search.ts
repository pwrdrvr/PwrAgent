import type {
  FederationJumpSearchProgress, FederationJumpSearchRequest, FederationJumpSearchResponse,
  FederationRemoteTarget, NavigationQueryPage, NavigationQueryRequest, NavigationRow,
} from "@pwragent/shared";
import { NAVIGATION_QUERY_MAX_RESULT_BYTES, sortThreadJumpMatches } from "@pwragent/shared";

/** Search retains only one bounded page per admitted owner for this request. */
export async function searchNavigationOwners(params: {
  request: FederationJumpSearchRequest;
  owners: readonly { target: FederationRemoteTarget; label: string }[];
  readPage: (request: NavigationQueryRequest) => Promise<NavigationQueryPage>;
  onProgress?: (progress: FederationJumpSearchProgress) => void;
}): Promise<FederationJumpSearchResponse> {
  const text = params.request.query.trim();
  if (!text) return { results: [] };
  const limit = Math.max(1, Math.min(params.request.limit ?? 8, 50));
  const unique = [...new Map(params.owners.map((owner) => [owner.target.instanceId, owner])).values()];
  const owners = unique.slice(0, 8);
  const notes = unique.length > owners.length ? ["Search covers eight instances. Open another instance to search it directly."] : [];
  const groups = new Map<string, NavigationRow[]>();
  let completedPeerCount = 0;
  const response = (): FederationJumpSearchResponse => {
    const results = sortThreadJumpMatches([...groups.values()].flat(), text).slice(0, limit);
    const resultNotes = [...notes];
    while (Buffer.byteLength(JSON.stringify({ results, notes: resultNotes })) > NAVIGATION_QUERY_MAX_RESULT_BYTES) {
      results.pop();
      if (!resultNotes.includes("Search results reached the response size limit.")) resultNotes.push("Search results reached the response size limit.");
    }
    return { results, ...(resultNotes.length ? { notes: resultNotes, incomplete: true } : {}) };
  };
  const publish = (): void => params.onProgress?.({ ...response(), completedPeerCount,
    totalPeerCount: owners.length, complete: completedPeerCount === owners.length });
  await Promise.all(owners.map(async (owner) => {
    try {
      const page = await params.readPage({ protocol: 2, consumer: "search", inventory: "owner",
        federationTarget: owner.target, query: { kind: "search", text }, pageSize: limit });
      if (page.protocol !== 2 || page.unchanged || page.entries.length > limit) {
        throw new Error("The owner returned an invalid search page.");
      }
      const rows = page.entries.map(({ row }) => {
        if (row.ref.ownerInstanceId !== owner.target.instanceId || row.ref.backend !== row.source || row.ref.threadId !== row.id) {
          throw new Error("The owner returned a mismatched search identity.");
        }
        return row;
      });
      groups.set(owner.target.instanceId, rows);
      if (page.coverage?.state !== "complete") notes.push(`${owner.label.slice(0, 128)}: search coverage is still loading.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Search is unavailable.";
      notes.push(`${owner.label.slice(0, 128)}: ${message.slice(0, 512)}`);
    } finally {
      completedPeerCount += 1;
      publish();
    }
  }));
  if (!owners.length) publish();
  return response();
}
