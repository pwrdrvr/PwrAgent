import type { MessagingBrowseSelectedProject } from "@pwragent/messaging-interface";
import { buildFederatedThreadRef } from "@pwragent/shared";
import type { FederationRemoteTarget, NavigationDirectoryRow, NavigationQuery, NavigationQueryPage, NavigationQueryRequest, NavigationRow } from "@pwragent/shared";

export type MessagingBrowseOwner = { target?: FederationRemoteTarget; label: string };
export type MessagingBrowseProjectRow = NavigationDirectoryRow & { owner?: MessagingBrowseOwner };
export type MessagingBrowsePage = {
  kind: "browse-page";
  threads: NavigationRow[];
  projects: MessagingBrowseProjectRow[];
  pageIndex: number;
  pageSize: number;
  totalItems: number;
  totalItemsComplete: boolean;
  selectedProject?: MessagingBrowseSelectedProject;
  hasNext: boolean;
  notes: string[];
};

type OwnerPage = {
  owner: MessagingBrowseOwner;
  rows: Array<NavigationRow | MessagingBrowseProjectRow>;
  cursor?: string;
  generation?: string;
  ownerEpoch?: string;
  started: boolean;
  complete: boolean;
  total: number;
  selectedProject?: MessagingBrowseSelectedProject;
  error?: string;
};
type BrowseGeneration = {
  signature: string;
  owners: OwnerPage[];
  pages: Map<number, MessagingBrowsePage>;
  nextPage: number;
  touchedAt: number;
  pending?: Promise<unknown>;
};

const MAX_OWNERS = 8;
const MAX_SESSIONS = 16;
const MAX_RETAINED_PAGES = 8;
const MAX_RETAINED_BYTES = 8 * 1024 * 1024;
const IDLE_MS = 60_000;

/** Bounded merge of owner cursors. It retains only small pages, never an owner inventory. */
export class MessagingBrowseQueryPool {
  private readonly sessions = new Map<string, BrowseGeneration>();
  private disposed = false;
  private pendingReads = 0;

  constructor(private readonly readOwner: (request: NavigationQueryRequest) => Promise<NavigationQueryPage>,
    private readonly now: () => number = Date.now) {}

  clear(): void {
    this.disposed = true;
    this.sessions.clear();
  }

  release(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  async read(params: {
    sessionId: string;
    query: NavigationQuery;
    owners: MessagingBrowseOwner[];
    pageSize: number;
    pageIndex: number;
    omittedOwners?: number;
    deadlineAt?: number;
    onProgress?: (page: MessagingBrowsePage) => Promise<void>;
  }): Promise<MessagingBrowsePage> {
    if (this.disposed) throw new Error("Messaging browser closed.");
    if (this.pendingReads >= 32) throw new Error("Messaging browser query admission is full. Try again after the current pages finish.");
    if (!Number.isInteger(params.pageSize) || params.pageSize < 1 || params.pageSize > 10) throw new Error("Messaging pages accept 1–10 items.");
    if (!Number.isSafeInteger(params.pageIndex) || params.pageIndex < 0) throw new Error("Invalid messaging page.");
    const owners = [...new Map(params.owners.map((owner) => [owner.target?.instanceId ?? "local", owner])).values()];
    const admittedOwners = owners.slice(0, MAX_OWNERS);
    const signature = JSON.stringify([params.query, admittedOwners, params.pageSize, params.omittedOwners]);
    const now = this.now();
    let generation = this.sessions.get(params.sessionId);
    let rebaseline = false;
    if (!generation || generation.signature !== signature || generation.touchedAt + IDLE_MS <= now
      || (!generation.pages.has(params.pageIndex) && params.pageIndex < generation.nextPage)) {
      rebaseline = params.pageIndex > 0;
      this.sessions.delete(params.sessionId);
      for (const [key, old] of this.sessions) if (!old.pending && old.touchedAt + IDLE_MS <= now) this.sessions.delete(key);
      if (this.sessions.size >= MAX_SESSIONS) throw new Error("Too many messaging browsers are open. Close a browser and try again.");
      generation = { signature, owners: admittedOwners.map((owner) => ({ owner, rows: [], started: false, complete: false, total: 0 })),
        pages: new Map(), nextPage: 0, touchedAt: now };
      this.sessions.set(params.sessionId, generation);
    }
    const current = generation;
    const requestedPage = rebaseline ? 0 : params.pageIndex;
    const run = async (): Promise<MessagingBrowsePage> => {
      this.assertCurrent(params.sessionId, current);
      const cached = current.pages.get(requestedPage);
      if (cached) { current.touchedAt = this.now(); return cached; }
      if (requestedPage !== current.nextPage) throw new Error("Refresh this browser before jumping to an unloaded page.");
      const deadlineAt = params.deadlineAt ?? this.now() + 10_000;
      const projects = params.query.kind === "messaging-projects";
      const chosen: Array<NavigationRow | MessagingBrowseProjectRow> = [];
      let progress = Promise.resolve();
      const selectedProject = (): MessagingBrowseSelectedProject | undefined => {
        const selected = current.owners.flatMap((owner) => owner.selectedProject ? [owner.selectedProject] : []);
        return selected.length === 1 ? selected[0] : undefined;
      };
      const publishProgress = async (): Promise<void> => {
        if (!params.onProgress || requestedPage !== 0 || current.owners.length < 2) return;
        const rows = current.owners.flatMap((owner) => owner.rows).sort((left, right) => this.compare(left, right, params.query)).slice(0, params.pageSize);
        const pending = current.owners.filter((owner) => !owner.started && !owner.error).length;
        if (!pending) return;
        const page: MessagingBrowsePage = { kind: "browse-page", projects: projects ? rows as MessagingBrowseProjectRow[] : [],
          threads: projects ? [] : rows as NavigationRow[], pageIndex: 0, pageSize: params.pageSize,
          totalItems: current.owners.reduce((sum, owner) => sum + owner.total, 0), totalItemsComplete: false,
          selectedProject: selectedProject(), hasNext: false,
          notes: [...current.owners.flatMap((owner) => owner.error ? [`${owner.owner.label}: ${owner.error}`] : []),
            ...(pending ? [`Still checking ${pending} Federation instances.`] : [])] };
        progress = progress.then(() => params.onProgress!(page));
        await progress;
      };
      const fill = async (owner: OwnerPage): Promise<void> => {
        if (owner.rows.length || owner.complete || owner.error) return;
        if (this.now() >= deadlineAt) throw new Error("Messaging browser query timed out. Refresh to retry.");
        try {
          const page = await this.readOwner({ protocol: 2, consumer: "messaging-browse", query: params.query,
            pageSize: params.pageSize, federationTarget: owner.owner.target, cursor: owner.cursor, deadlineAt });
          this.assertCurrent(params.sessionId, current);
          if (page.protocol !== 2 || page.unchanged || !Number.isSafeInteger(page.collectionSize) || page.collectionSize! < 0
            || (!page.complete && !page.nextCursor)) throw new Error("Upgrade this owner to support bounded messaging pages.");
          if (owner.started && (owner.generation !== page.generation || owner.ownerEpoch !== page.ownerEpoch)) {
            throw Object.assign(new Error("Owner navigation generation changed."), { code: "navigation_cursor_expired" });
          }
          if ((projects ? page.directories?.length ?? 0 : page.entries.length) > params.pageSize) throw new Error("The owner exceeded the requested page size.");
          const previousCursor = owner.cursor;
          owner.generation = page.generation;
          owner.ownerEpoch = page.ownerEpoch;
          owner.started = true;
          owner.total = page.collectionSize!;
          if (page.selectionDirectory) owner.selectedProject = { directoryKey: page.selectionDirectory.key,
            label: page.selectionDirectory.label, path: page.selectionDirectory.path,
            ...(owner.owner.target ? { federationTarget: owner.owner.target } : {}) };
          owner.complete = page.complete;
          owner.cursor = page.nextCursor;
          if (previousCursor && owner.cursor === previousCursor) throw new Error("The owner returned a repeated navigation cursor.");
          owner.rows = projects ? (page.directories ?? []).map((row) => ({ ...row, owner: owner.owner }))
            : page.entries.map(({ row }) => {
              const ownerId = owner.owner.target?.instanceId;
              if (row.ref.ownerInstanceId && row.ref.ownerInstanceId !== ownerId) throw new Error("Navigation row belongs to a different owner.");
              if (!ownerId) return row;
              return { ...row, ref: { ...row.ref, ownerInstanceId: ownerId }, federation: { ...row.federation,
                instanceLabel: owner.owner.label, ref: buildFederatedThreadRef({ backend: row.source, threadId: row.id, instanceId: ownerId }) } };
            });
          if (!owner.rows.length && !owner.complete) throw new Error("The owner returned an empty continuing page.");
          if (page.coverage.state !== "complete") owner.error = "Owner inventory is incomplete.";
          this.checkBytes(current);
        } catch (error) {
          this.assertCurrent(params.sessionId, current);
          if (typeof error === "object" && error !== null && "code" in error && error.code === "navigation_cursor_expired") throw error;
          owner.error = error instanceof Error ? error.message : String(error);
          owner.complete = true;
        }
        await publishProgress();
      };
      while (chosen.length < params.pageSize) {
        await Promise.all(current.owners.map(fill));
        this.assertCurrent(params.sessionId, current);
        const next = current.owners.filter((owner) => owner.rows.length)
          .sort((left, right) => this.compare(left.rows[0]!, right.rows[0]!, params.query))[0];
        if (!next) break;
        chosen.push(next.rows.shift()!);
      }
      const notes = current.owners.flatMap((owner) => owner.error ? [`${owner.owner.label}: ${owner.error}`] : []);
      const omitted = Math.max(0, owners.length - MAX_OWNERS) + (params.omittedOwners ?? 0);
      if (omitted) notes.push(`${omitted} owners exceed this browser's eight-owner budget. Results are incomplete.`);
      if (rebaseline) notes.push("The previous page expired. Results restarted from the first page.");
      const page: MessagingBrowsePage = { kind: "browse-page", threads: projects ? [] : chosen as NavigationRow[],
        projects: projects ? chosen as MessagingBrowseProjectRow[] : [], pageIndex: requestedPage, pageSize: params.pageSize,
        totalItems: current.owners.reduce((sum, owner) => sum + owner.total, 0),
        totalItemsComplete: omitted === 0 && current.owners.every((owner) => !owner.error),
        selectedProject: selectedProject(),
        hasNext: current.owners.some((owner) => owner.rows.length || (!owner.complete && !owner.error)), notes };
      current.pages.set(requestedPage, page);
      current.nextPage += 1;
      current.touchedAt = this.now();
      while (current.pages.size > MAX_RETAINED_PAGES) current.pages.delete(current.pages.keys().next().value!);
      this.checkBytes(current);
      return page;
    };
    this.pendingReads += 1;
    const result = (current.pending ?? Promise.resolve()).then(run);
    current.pending = result;
    try { return await result; }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "navigation_cursor_expired" && params.pageIndex > 0) {
        this.release(params.sessionId);
        const page = await this.read({ ...params, pageIndex: 0, deadlineAt: params.deadlineAt ?? now + 10_000 });
        return { ...page, notes: [...page.notes, "The owner cursor expired. Results restarted from the first page."] };
      }
      throw error;
    }
    finally { this.pendingReads -= 1; if (current.pending === result) current.pending = undefined; }
  }

  private assertCurrent(sessionId: string, generation: BrowseGeneration): void {
    if (this.disposed || this.sessions.get(sessionId) !== generation) throw new Error("This messaging browser request was superseded.");
  }

  private checkBytes(current: BrowseGeneration): void {
    let bytes = 0;
    for (const generation of this.sessions.values()) {
      bytes += Buffer.byteLength(JSON.stringify([generation.owners, [...generation.pages.values()]]));
    }
    if (bytes > MAX_RETAINED_BYTES) {
      for (const [key, generation] of this.sessions) if (generation === current) this.sessions.delete(key);
      throw new Error("Messaging browser pages exceed the retained-memory budget. Narrow the search and try again.");
    }
  }

  private compare(left: NavigationRow | MessagingBrowseProjectRow, right: NavigationRow | MessagingBrowseProjectRow, query: NavigationQuery): number {
    if ("key" in left && "key" in right) {
      return (query.kind === "messaging-projects" && query.scratchpadFirst
        ? Number(right.kind === "workspace") - Number(left.kind === "workspace") : 0)
        || (right.latestUpdatedAt ?? 0) - (left.latestUpdatedAt ?? 0) || left.label.localeCompare(right.label);
    }
    if ("id" in left && "id" in right) return (right.updatedAt ?? right.createdAt ?? 0) - (left.updatedAt ?? left.createdAt ?? 0)
      || JSON.stringify(left.ref).localeCompare(JSON.stringify(right.ref));
    return 0;
  }
}
