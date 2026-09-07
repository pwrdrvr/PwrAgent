import { buildFederatedThreadRef } from "@pwragent/shared";
import type { ArchiveThreadRequest, FederationTarget, NavigationIdentity, NavigationQueryEntry, NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";

export type NavigationArchiveMember = Pick<NavigationThreadSummary, "id" | "source" | "federation"> & {
  federationTarget?: FederationTarget;
  expectedParent?: ArchiveThreadRequest["expectedParent"];
};
type Member = { ref: NavigationIdentity; parent?: NavigationIdentity; expectedParent: ArchiveThreadRequest["expectedParent"] };
let nextGroupRead = 0;

/** Discover with viewer metadata; only owner-confirmed relationships enter the archive plan. */
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
  const admit = (ref: NavigationIdentity): void => {
    discovered.set(key(ref), normalize(ref));
    if (discovered.size > 1000 || new TextEncoder().encode(JSON.stringify([...discovered.values(), ...authoritative.values()])).byteLength > 1024 * 1024) {
      throw new Error("Thread group exceeds the 1,000-member or 1 MiB archive planning budget. Archive a smaller subgroup.");
    }
  };
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
        if (!viewer) authoritative.set(key(ref), member(entry, ref));
        admit(ref);
      }
      cursor = page.nextCursor;
      if (!cursor && !page.complete) throw new Error("Thread group membership is incomplete. No threads were archived.");
      if (cursor && (cursors.has(cursor) || !page.entries.length)) throw new Error("Thread group cursor did not advance.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
  };
  const member = (entry: NavigationQueryEntry, ref: NavigationIdentity): Member => ({ ref,
    parent: entry.placement.kind === "child" ? normalize(entry.placement.parent) : undefined,
    expectedParent: entry.row.parentThreadId ? { threadId: entry.row.parentThreadId,
      backend: entry.row.parentThreadBackend ?? entry.row.source, instanceId: entry.row.parentThreadInstanceId } : null });
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
    const visit = (value: Member, depth: number): void => {
      const id = key(value.ref);
      if (visiting.has(id) || depth > 32) throw new Error("Thread group has a cycle or exceeds 32 levels.");
      visiting.add(id);
      for (const child of children.get(id) ?? []) visit(child, depth + 1);
      visiting.delete(id);
      result.push({ source: value.ref.backend, id: value.ref.threadId, expectedParent: value.expectedParent,
        federationTarget: value.ref.ownerInstanceId ? { scope: "remote", instanceId: value.ref.ownerInstanceId } : { scope: "local" },
        ...(value.ref.ownerInstanceId ? { federation: { instanceLabel: value.ref.ownerInstanceId,
          ref: buildFederatedThreadRef({ backend: value.ref.backend, threadId: value.ref.threadId, instanceId: value.ref.ownerInstanceId }) } } : {}) });
    };
    visit(authoritative.get(key(root))!, 0);
    return result;
  } finally { await params.api.releaseNavigationQuery?.(token).catch(() => undefined); }
}
