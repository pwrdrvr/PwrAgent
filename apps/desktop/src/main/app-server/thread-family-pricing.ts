import {
  NAVIGATION_QUERY_PROTOCOL_VERSION,
  summarizeThreadFamilyPricing,
  type ReadThreadFamilyPricingRequest,
  type ReadThreadFamilyPricingResponse,
  type ThreadPricingSummary,
} from "@pwragent/shared";
import { projectNavigationQuery, type NavigationQueryIndex } from "./navigation-query-projection";

/**
 * Total a thread and every sub-thread under it, recursively. Membership comes
 * from the sidebar's own `group-members` projection, so the card and the
 * sub-thread tray never disagree about who is in the family. Native sub-agent
 * workers are not ordinary rows there, and their spend is already inside the
 * thread that started them.
 *
 * This reads stored totals once when the Pricing tab opens. It writes nothing.
 */
export async function readThreadFamilyPricing(params: {
  request: ReadThreadFamilyPricingRequest;
  loadIndex: () => Promise<NavigationQueryIndex>;
  readSummaries: (threads: Array<{ backend: ReadThreadFamilyPricingRequest["backend"]; threadId: string }>) => Promise<ThreadPricingSummary[]>;
  now?: () => number;
}): Promise<ReadThreadFamilyPricingResponse> {
  const root = { backend: params.request.backend, threadId: params.request.threadId };
  const index = await params.loadIndex();
  const materialization = projectNavigationQuery({
    index,
    request: {
      protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
      consumer: "main-sidebar",
      query: { kind: "group-members", roots: [root] },
    },
  });
  // The local index carries only this machine's threads, so every member's
  // pricing lives here. A sub-thread owned by a peer never appears.
  const members = materialization.entries
    .filter(({ row }) => !row.ref.ownerInstanceId)
    .map(({ row }) => ({
      backend: row.ref.backend,
      threadId: row.ref.threadId,
      title: row.title,
      threadStatus: row.threadStatus,
    }));
  const summaries = await params.readSummaries(members);
  return summarizeThreadFamilyPricing({
    root,
    members,
    summaries,
    readAt: params.now?.() ?? Date.now(),
  });
}
