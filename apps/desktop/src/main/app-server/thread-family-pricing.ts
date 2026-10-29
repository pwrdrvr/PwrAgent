import {
  NAVIGATION_QUERY_PROTOCOL_VERSION,
  compareThreadFamilyPricingMembers,
  summarizeThreadFamilyPricing,
  type AppServerBackendKind,
  type NavigationIdentity,
  type ReadThreadFamilyPricingResponse,
  type ThreadFamilyPricingInputMember,
  type ThreadFamilyPricingMember,
  type ThreadFamilyPricingReferral,
  type ThreadPricingSummary,
} from "@pwragent/shared";
import { projectNavigationQuery, type NavigationQueryIndex } from "./navigation-query-projection";

/** A family can span machines; past this many owner reads the rest is left out. */
const MAX_FAMILY_ROOT_READS = 64;
const MAX_FAMILY_MEMBERS = 500;
/**
 * One budget for every owner read in a family read, not one per owner: owners
 * are asked in rounds, so per-read timeouts would stack. A slow owner's rows
 * then show as not included instead of holding the whole card on loading.
 */
export const THREAD_FAMILY_PRICING_PEER_BUDGET_MS = 10_000;

/**
 * Total a thread and every sub-thread under it that this machine keeps.
 * Membership comes from the sidebar's own `group-members` projection, so the
 * card and the sub-thread tray never disagree about who is in the family.
 * Native sub-agent workers are not ordinary rows there, and their spend is
 * already inside the thread that started them.
 *
 * The index can carry this machine's pins of other instances' threads. Those
 * are family members too, but only their owner keeps their totals, so they come
 * back as referrals for the reader to ask that owner about.
 *
 * The root may itself live on another instance: this machine can still keep
 * sub-threads under it. It is then not a member here.
 *
 * This reads stored totals once when the Pricing tab opens. It writes nothing.
 */
export async function readThreadFamilyPricing(params: {
  root: NavigationIdentity;
  loadIndex: () => Promise<NavigationQueryIndex>;
  readSummaries: (threads: Array<{ backend: AppServerBackendKind; threadId: string }>) => Promise<ThreadPricingSummary[]>;
  now?: () => number;
}): Promise<ReadThreadFamilyPricingResponse> {
  const index = await params.loadIndex();
  const root = params.root.ownerInstanceId && params.root.ownerInstanceId === index.localInstanceId
    ? { backend: params.root.backend, threadId: params.root.threadId } : params.root;
  const materialization = projectNavigationQuery({
    index,
    request: {
      protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
      consumer: "main-sidebar",
      query: { kind: "group-members", roots: [root] },
    },
  });
  const members: ThreadFamilyPricingInputMember[] = [];
  const referrals: ThreadFamilyPricingReferral[] = [];
  for (const { row } of materialization.entries) {
    const owner = row.ref.ownerInstanceId;
    if (owner && owner !== index.localInstanceId) {
      referrals.push({
        backend: row.ref.backend,
        threadId: row.ref.threadId,
        ownerInstanceId: owner,
        title: row.title,
        ...(row.federation?.instanceLabel ? { instanceLabel: row.federation.instanceLabel } : {}),
      });
      continue;
    }
    members.push({ backend: row.ref.backend, threadId: row.ref.threadId, title: row.title, threadStatus: row.threadStatus });
  }
  const summaries = members.length ? await params.readSummaries(members) : [];
  const family = summarizeThreadFamilyPricing({
    ...(root.ownerInstanceId ? {} : { root }),
    members,
    summaries,
    readAt: params.now?.() ?? Date.now(),
  });
  return referrals.length ? { ...family, referrals } : family;
}

/**
 * What an owner tells a peer. Another instance's thread titles stay on the
 * machine that pinned them; the reader learns them from that instance.
 */
export function threadFamilyPricingForPeer(family: ReadThreadFamilyPricingResponse): ReadThreadFamilyPricingResponse {
  if (!family.referrals) return family;
  return {
    ...family,
    referrals: family.referrals.map(({ backend, threadId, ownerInstanceId }) => ({ backend, threadId, ownerInstanceId })),
  };
}

type PendingRoot = {
  root: NavigationIdentity;
  title?: string;
  instanceLabel?: string;
};

/**
 * Total a family whose threads can live on several machines. Each owner keeps
 * its own threads' totals, so each one is asked for its part, and the
 * referrals it returns lead to the next owner. This machine is also asked
 * about every remote thread, since it can keep sub-threads under one.
 *
 * A remote sub-thread whose owner cannot be reached stays in the list, marked
 * unavailable and left out of the total. A remote root that cannot be read
 * fails the whole read: there is no family to show without it.
 */
export async function readFederatedThreadFamilyPricing(params: {
  root: NavigationIdentity;
  /** This machine's part, from its own index and pins. */
  readLocal: (root: NavigationIdentity) => Promise<ReadThreadFamilyPricingResponse>;
  /** The owner's part, read over federation, due by `deadlineAt`. */
  readRemote: (
    instanceId: string,
    root: { backend: AppServerBackendKind; threadId: string },
    deadlineAt: number,
  ) => Promise<ReadThreadFamilyPricingResponse>;
  localInstanceId?: string;
  peerLabel?: (instanceId: string) => string | undefined;
  now?: () => number;
}): Promise<ReadThreadFamilyPricingResponse> {
  const ownerOf = (instanceId: string | undefined): string | undefined =>
    instanceId && instanceId !== params.localInstanceId ? instanceId : undefined;
  const key = (owner: string | undefined, backend: string, threadId: string): string =>
    JSON.stringify([owner ?? null, backend, threadId]);
  const rootOwner = ownerOf(params.root.ownerInstanceId);
  const rootKey = key(rootOwner, params.root.backend, params.root.threadId);
  const label = (owner: string, fallback?: string): string | undefined => params.peerLabel?.(owner) ?? fallback;
  const members = new Map<string, ThreadFamilyPricingMember>();
  const queried = new Set<string>();
  const deadlineAt = (params.now?.() ?? Date.now()) + THREAD_FAMILY_PRICING_PEER_BUDGET_MS;
  let pending: PendingRoot[] = [{ root: params.root }];

  const admit = (response: ReadThreadFamilyPricingResponse, owner: string | undefined, fallbackLabel?: string): PendingRoot[] => {
    for (const member of response.members) {
      const memberOwner = ownerOf(member.ownerInstanceId ?? owner);
      const memberKey = key(memberOwner, member.backend, member.threadId);
      const existing = members.get(memberKey);
      if (existing && !existing.unavailable) continue;
      if (!existing && members.size >= MAX_FAMILY_MEMBERS) continue;
      const { self: _self, ownerInstanceId: _owner, instanceLabel: _label, unavailable: _unavailable, ...totals } = member;
      const instanceLabel = memberOwner ? label(memberOwner, member.instanceLabel ?? fallbackLabel) : undefined;
      members.set(memberKey, {
        ...totals,
        self: memberKey === rootKey,
        ...(memberOwner ? { ownerInstanceId: memberOwner } : {}),
        ...(instanceLabel ? { instanceLabel } : {}),
      });
    }
    return (response.referrals ?? []).map((referral) => {
      const referralOwner = ownerOf(referral.ownerInstanceId);
      return {
        root: {
          backend: referral.backend,
          threadId: referral.threadId,
          ...(referralOwner ? { ownerInstanceId: referralOwner } : {}),
        },
        ...(referral.title ? { title: referral.title } : {}),
        ...(referral.instanceLabel ? { instanceLabel: referral.instanceLabel } : {}),
      };
    });
  };

  while (pending.length) {
    const round = pending.filter((item) => {
      const itemKey = key(ownerOf(item.root.ownerInstanceId), item.root.backend, item.root.threadId);
      if (queried.has(itemKey) || queried.size >= MAX_FAMILY_ROOT_READS) return false;
      queried.add(itemKey);
      return true;
    });
    pending = [];
    const next = await Promise.all(round.map(async (item): Promise<PendingRoot[]> => {
      const owner = ownerOf(item.root.ownerInstanceId);
      const { backend, threadId } = item.root;
      if (!owner) return admit(await params.readLocal({ backend, threadId }), undefined);
      const [remote, local] = await Promise.allSettled([
        params.readRemote(owner, { backend, threadId }, deadlineAt),
        params.readLocal({ backend, threadId, ownerInstanceId: owner }),
      ]);
      const found: PendingRoot[] = [];
      if (remote.status === "fulfilled") {
        found.push(...admit(remote.value, owner, item.instanceLabel));
      } else if (key(owner, backend, threadId) === rootKey) {
        throw remote.reason;
      } else {
        const memberKey = key(owner, backend, threadId);
        const instanceLabel = label(owner, item.instanceLabel);
        if (!members.has(memberKey) && members.size < MAX_FAMILY_MEMBERS) {
          members.set(memberKey, {
            backend,
            threadId,
            title: item.title ?? "Sub-thread",
            self: false,
            active: false,
            totalCostMicros: 0,
            usageLineCount: 0,
            unpricedUsageLineCount: 0,
            ownerInstanceId: owner,
            ...(instanceLabel ? { instanceLabel } : {}),
            unavailable: true,
          });
        }
      }
      // This machine's knowledge of the remote thread is a hint; the owner's
      // answer above is what counts.
      if (local.status === "fulfilled") found.push(...admit(local.value, undefined));
      return found;
    }));
    pending = next.flat();
  }

  return {
    members: [...members.values()].sort(compareThreadFamilyPricingMembers),
    readAt: params.now?.() ?? Date.now(),
  };
}
