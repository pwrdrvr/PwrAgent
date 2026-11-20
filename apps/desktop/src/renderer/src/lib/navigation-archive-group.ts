import { buildFederatedThreadRef } from "@pwragent/shared/contracts/federation";
import type { FederationTarget } from "@pwragent/shared/contracts/federation";
import type {
  NavigationIdentity,
  NavigationQueryEntry,
  NavigationThreadSummary,
} from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "./desktop-api";

export type NavigationArchiveMember = Pick<NavigationThreadSummary, "id" | "source" | "federation"> & {
  federationTarget?: FederationTarget;
} & Partial<Pick<NavigationThreadSummary, "title" | "titleSource" | "linkedDirectories" | "gitBranch">>;
type Member = { ref: NavigationIdentity; parent?: NavigationIdentity;
  instanceLabel?: string;
  metadata: Pick<NavigationThreadSummary, "title" | "titleSource" | "linkedDirectories" | "gitBranch"> };
let nextGroupRead = 0;

/** Snapshot identities from the viewer and owners; owner relationships determine order, not membership. */
export async function readNavigationArchiveGroup(params: {
  api: Pick<DesktopApi, "getNavigationQueryPage" | "releaseNavigationQuery" | "readFederationHealth">;
  thread: NavigationThreadSummary;
  windowTarget?: FederationTarget;
}): Promise<NavigationArchiveMember[]> {
  if (!params.api.getNavigationQueryPage) throw new Error("Upgrade this instance to read the complete thread group before archiving.");
  const deadlineAt = Date.now() + 10_000;
  const localInstanceId = params.api.readFederationHealth
    ? (await params.api.readFederationHealth()).health.instanceId : undefined;
  const normalize = (ref: NavigationIdentity): NavigationIdentity => ref.ownerInstanceId === localInstanceId
    ? { backend: ref.backend, threadId: ref.threadId } : ref;
  const key = (ref: NavigationIdentity): string => {
    const value = normalize(ref);
    return JSON.stringify([value.ownerInstanceId ?? null, value.backend, value.threadId]);
  };
  const target = params.thread.federation?.ref.target ?? params.windowTarget;
  const root = normalize({ backend: params.thread.source, threadId: params.thread.id,
    ...(target?.scope === "remote" ? { ownerInstanceId: target.instanceId } : {}) });
  const discovered = new Map<string, NavigationIdentity>([[key(root), root]]);
  const authoritative = new Map<string, Member>();
  const queried = new Set<string>();
  const token = `archive-group:${++nextGroupRead}`;
  // The budget is the size of the serialized plan: every discovered identity
  // and every owner row. Charge each entry once, when it first enters, so a
  // 1,000-member group costs one pass rather than one re-encode per row.
  const encoder = new TextEncoder();
  const charged = new Set<string>();
  let plannedBytes = 2;
  const charge = (entry: string, value: unknown): void => {
    if (charged.has(entry)) return;
    charged.add(entry);
    plannedBytes += encoder.encode(JSON.stringify(value)).byteLength + (charged.size > 1 ? 1 : 0);
  };
  const admit = (ref: NavigationIdentity, owned?: Member): void => {
    const id = key(ref);
    if (owned) {
      authoritative.set(id, owned);
      charge(`owner:${id}`, owned);
    }
    discovered.set(id, normalize(ref));
    charge(`discovered:${id}`, normalize(ref));
    if (discovered.size > 1000 || plannedBytes > 1024 * 1024) {
      throw new Error("Thread group exceeds the 1,000-member or 1 MiB archive planning budget. Archive a smaller subgroup.");
    }
  };
  charge(`discovered:${key(root)}`, root);
  const read = async (roots: NavigationIdentity[], owner: string | undefined, viewer: boolean): Promise<void> => {
    let cursor: string | undefined;
    let generation: string | undefined;
    let epoch: string | undefined;
    const cursors = new Set<string>();
    do {
      if (Date.now() >= deadlineAt) throw new Error("Thread group discovery timed out. No threads were archived.");
      const page = await params.api.getNavigationQueryPage!({ protocol: 2, consumer: "main-sidebar",
        inventory: viewer ? "viewer" : "owner", query: { kind: "group-members", roots }, pageSize: 10,
        federationTarget: owner ? { scope: "remote", instanceId: owner } : undefined, cursor, deadlineAt }, token);
      if (page.coverage.state === "degraded") {
        throw new Error("Thread group membership is incomplete: a provider did not list its threads. No threads were archived. Try again once it reconnects.");
      }
      // The owner waits for its startup provider check within the deadline.
      if (page.coverage.state === "checking") {
        throw new Error("PwrAgent is still listing threads from its providers. No threads were archived. Try again in a moment.");
      }
      if (page.protocol !== 2 || page.unchanged || page.coverage.state !== "complete" || page.entries.length > 10
        || (generation && (generation !== page.generation || epoch !== page.ownerEpoch))) {
        throw new Error("Thread group membership is incomplete or changed during discovery. Refresh and try again.");
      }
      generation = page.generation;
      epoch = page.ownerEpoch;
      for (const entry of page.entries) {
        const ref = normalize(entry.row.ref);
        if (ref.backend !== entry.row.source || ref.threadId !== entry.row.id || (!viewer && ref.ownerInstanceId !== owner)) {
          throw new Error("Thread group response belongs to a different owner.");
        }
        if (!viewer && owner && !entry.row.federation?.capabilities?.includes("turn_control")) {
          throw new Error(`The owner ${owner} has not granted thread control. No threads were archived.`);
        }
        admit(ref, viewer ? undefined : member(entry, ref));
      }
      cursor = page.nextCursor;
      if (!cursor && !page.complete) throw new Error("Thread group membership is incomplete. No threads were archived.");
      if (cursor && (cursors.has(cursor) || !page.entries.length)) throw new Error("Thread group cursor did not advance.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
  };
  const member = (entry: NavigationQueryEntry, ref: NavigationIdentity): Member => ({ ref,
    instanceLabel: entry.row.federation?.instanceLabel,
    metadata: { title: entry.row.title, titleSource: entry.row.titleSource, linkedDirectories: entry.row.linkedDirectories, gitBranch: entry.row.gitBranch },
    parent: entry.placement.kind === "child" ? normalize(entry.placement.parent) : undefined });
  try {
    while (true) {
      const pending = [...discovered].filter(([id]) => !queried.has(id));
      if (!pending.length) break;
      const owners = new Set([...discovered.values()].map((ref) => ref.ownerInstanceId ?? "local"));
      if (owners.size > 8) throw new Error("Thread group spans more than eight owners. Archive a smaller subgroup.");
      const owner = pending[0]![1].ownerInstanceId;
      const roots = pending.filter(([, ref]) => ref.ownerInstanceId === owner).slice(0, 50).map(([id, ref]) => {
        queried.add(id);
        return ref;
      });
      await read(roots, owner, false);
      {
        const viewerRoots = [...roots, ...roots.filter((ref) => !ref.ownerInstanceId && localInstanceId)
          .map((ref) => ({ ...ref, ownerInstanceId: localInstanceId }))];
        await read(viewerRoots, undefined, true);
      }
    }
    if (!authoritative.has(key(root))) throw new Error("The group root is no longer present on its owner.");
    const children = new Map<string, Member[]>();
    for (const value of authoritative.values()) if (value.parent) {
      const parent = key(value.parent);
      const siblings = children.get(parent) ?? [];
      siblings.push(value);
      children.set(parent, siblings);
    }
    const result: NavigationArchiveMember[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (value: Member, depth: number): void => {
      const id = key(value.ref);
      if (visited.has(id)) return;
      if (visiting.has(id) || depth > 32) throw new Error("Thread group has a cycle or exceeds 32 levels.");
      visiting.add(id);
      for (const child of children.get(id) ?? []) visit(child, depth + 1);
      visiting.delete(id);
      visited.add(id);
      result.push({ ...value.metadata, source: value.ref.backend, id: value.ref.threadId,
        federationTarget: value.ref.ownerInstanceId ? { scope: "remote", instanceId: value.ref.ownerInstanceId } : { scope: "local" },
        ...(value.ref.ownerInstanceId ? { federation: { instanceLabel: value.instanceLabel ?? value.ref.ownerInstanceId,
          ref: buildFederatedThreadRef({ backend: value.ref.backend, threadId: value.ref.threadId, instanceId: value.ref.ownerInstanceId }) } } : {}) });
    };
    // A viewer mount can name a flattened or older parent. The owner may name
    // an intermediate ancestor absent from this viewer. Keep the explicitly
    // discovered identity even then, and visit each selected identity once.
    // Visit other selected branches before the requested root, respecting the
    // actual child edges between selected identities.
    for (const value of authoritative.values()) if (key(value.ref) !== key(root)) visit(value, 0);
    visit(authoritative.get(key(root))!, 0);
    return result;
  } finally { await params.api.releaseNavigationQuery?.(token).catch(() => undefined); }
}
