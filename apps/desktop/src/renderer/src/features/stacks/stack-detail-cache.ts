import { NAVIGATION_QUERY_PROTOCOL_VERSION, type NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { CompactStackMembership, StackSummary } from "@pwragent/shared/stacks/stack-status";
import type { DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";

type ReadSelectedDetail = NonNullable<DesktopApi["getNavigationSelectedDetail"]>;
export type SelectedStacksResult = { stacks: StackSummary[]; error?: undefined } | { stacks?: undefined; error: string };

const RESULT_LIMIT = 32;
const STACK_LIMIT = 64;
/** A preview can omit memberships, so a result keyed by it also ages out. */
const RESULT_TTL_MS = 120_000;

const results = new Map<string, { stacks: StackSummary[]; at: number }>();
const pending = new Map<string, Promise<SelectedStacksResult>>();
const stacksByRevision = new Map<string, StackSummary>();

export function stackOwnerInstanceId(thread: NavigationThreadSummary | undefined): string | undefined {
  const target = thread?.federation?.ref.target ?? readRendererFederationTarget();
  return target?.scope === "remote" ? target.instanceId : undefined;
}

/** What the selected-stack answer for this row depends on. */
export function selectedStackSource(thread: NavigationThreadSummary | undefined, ownerInstanceId: string | undefined): string {
  return JSON.stringify([thread?.source, thread?.id, ownerInstanceId, thread?.stackMemberships,
    thread?.observedGitBranch, thread?.prs?.map(({ number, baseRefName, headSha, lifecycleState }) =>
      [number, baseRefName, headSha, lifecycleState])]);
}

/**
 * The owner stamps each membership with its stack's detail revision, which
 * changes whenever that stack does. Without one, nothing says when a copy
 * went stale, so such rows are read afresh every time.
 */
function cacheable(thread: NavigationThreadSummary | undefined): boolean {
  const memberships = thread?.stackMemberships;
  return Boolean(memberships?.length && memberships.every(({ detailRevision }) => detailRevision));
}

function stackKey(ownerInstanceId: string | undefined, key: string, revision: string): string {
  return JSON.stringify([ownerInstanceId ?? null, key, revision]);
}

function remember<V>(map: Map<string, V>, key: string, value: V, limit: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value!);
}

/** One stack exactly as its owner last sent it at this membership's revision. */
export function readCachedStack(ownerInstanceId: string | undefined, member: CompactStackMembership): StackSummary | undefined {
  return member.detailRevision ? stacksByRevision.get(stackKey(ownerInstanceId, member.key, member.detailRevision)) : undefined;
}

export function readCachedSelectedStacks(thread: NavigationThreadSummary | undefined, ownerInstanceId: string | undefined,
  now = Date.now()): StackSummary[] | undefined {
  if (!cacheable(thread)) return undefined;
  const entry = results.get(selectedStackSource(thread, ownerInstanceId));
  return entry && now - entry.at < RESULT_TTL_MS ? entry.stacks : undefined;
}

async function readAllStackLayers(read: ReadSelectedDetail, thread: NavigationThreadSummary,
  ownerInstanceId: string | undefined, active?: () => boolean): Promise<SelectedStacksResult> {
  const backend = thread.source;
  const threadId = thread.id;
  const ref = { backend, threadId, ownerInstanceId };
  const federationTarget = ownerInstanceId ? { scope: "remote" as const, instanceId: ownerInstanceId } : undefined;
  const stacks = new Map<string, StackSummary>();
  const cursors = new Set<string>();
  let revision: string | undefined;
  let cursor: string | undefined;
  let bytes = 0;
  for (;;) {
    const result = await read({
      protocol: NAVIGATION_QUERY_PROTOCOL_VERSION, ref, federationTarget,
      collection: { name: "stackLayers", cursor },
    });
    // Nobody keeps an uncached answer, so stop paging once its reader leaves.
    if (active && !active()) return { error: "Stack details were not needed." };
    const page = result.collectionPage;
    if (result.protocol !== NAVIGATION_QUERY_PROTOCOL_VERSION || result.readiness !== "ready"
      || result.ref.backend !== backend || result.ref.threadId !== threadId || result.ref.ownerInstanceId !== ownerInstanceId
      || page?.name !== "stackLayers" || (revision !== undefined && page.revision !== revision)) {
      throw new Error("Stack details changed while loading.");
    }
    revision = page.revision;
    const layers = page.values.stackLayers ?? [];
    bytes += new TextEncoder().encode(JSON.stringify(layers)).byteLength;
    if (bytes > 8 * 1024 * 1024) return { error: "Stack details exceed the display limit." };
    for (const { stackKey: key, stack, layer, position } of layers) {
      const current = stacks.get(key) ?? (stack?.key === key ? { ...stack, layers: [] } : undefined);
      if (!current || position !== current.layers.length + 1) throw new Error("Stack details arrived out of order.");
      current.layers.push(layer);
      stacks.set(key, current);
    }
    if (page.complete) return { stacks: [...stacks.values()] };
    cursor = page.nextCursor;
    if (!cursor || cursors.has(cursor) || !layers.length) throw new Error("Stack details did not finish loading.");
    cursors.add(cursor);
  }
}

/**
 * Read every stack layer for one row. Readers of the same row share one
 * request, and a row the owner stamped with detail revisions keeps the
 * answer: each stack is reusable by any other row that is a member of it at
 * the same revision.
 */
export function loadSelectedStacks(read: ReadSelectedDetail, thread: NavigationThreadSummary,
  ownerInstanceId: string | undefined, active?: () => boolean): Promise<SelectedStacksResult> {
  if (!cacheable(thread)) return readAllStackLayers(read, thread, ownerInstanceId, active);
  const source = selectedStackSource(thread, ownerInstanceId);
  const running = pending.get(source);
  if (running) return running;
  const memberships = thread.stackMemberships ?? [];
  const promise = readAllStackLayers(read, thread, ownerInstanceId).then((result) => {
    if (result.stacks) {
      remember(results, source, { stacks: result.stacks, at: Date.now() }, RESULT_LIMIT);
      for (const stack of result.stacks) {
        const revision = memberships.find(({ key }) => key === stack.key)?.detailRevision;
        if (revision) remember(stacksByRevision, stackKey(ownerInstanceId, stack.key, revision), stack, STACK_LIMIT);
      }
    }
    return result;
  }).finally(() => {
    if (pending.get(source) === promise) pending.delete(source);
  });
  pending.set(source, promise);
  return promise;
}

/** Start reading a row's stacks before its popover opens, when the answer can be kept. */
export function prefetchSelectedStacks(read: ReadSelectedDetail | undefined, thread: NavigationThreadSummary): void {
  const ownerInstanceId = stackOwnerInstanceId(thread);
  if (!read || !thread.linkedDirectories.length || !cacheable(thread)
    || readCachedSelectedStacks(thread, ownerInstanceId)) return;
  void loadSelectedStacks(read, thread, ownerInstanceId).catch(() => undefined);
}

export function resetStackDetailCacheForTests(): void {
  results.clear();
  pending.clear();
  stacksByRevision.clear();
}
