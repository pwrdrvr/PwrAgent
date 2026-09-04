import type { NavigationThreadSummary } from "./navigation";

/**
 * Star Map card arrangement: operator-dragged offsets for attention-thread
 * cards, keyed by owning instance + thread identity, synced across the
 * federation last-writer-wins so every instance renders the same map.
 *
 * Offsets are relative to the card's default slot (not absolute pixels), so
 * layouts survive viewport differences between machines. A null offset pair
 * is a tombstone: "back to the default slot", propagated like any write so
 * resets converge too.
 */

export type StarMapArrangementEntry = {
  /** Federation instance that owns the thread this card represents. */
  instanceId: string;
  /** buildThreadIdentityKey(source, id) of the thread. */
  threadKey: string;
  /** Pixel offset from the default slot; null with null dy = tombstone. */
  dx: number | null;
  dy: number | null;
  updatedAt: number;
  /** Instance that made the write — the deterministic LWW tiebreak. */
  by: string;
};

/**
 * Reserved `threadKey` for an instance's load card. Thread keys are
 * `buildThreadIdentityKey(source, id)` and every real backend source is a
 * known kind, so a `system:` prefix cannot collide with one.
 *
 * Using the existing record instead of adding a field keeps this change
 * additive on the wire: arrangement entries cross the federation, and an
 * older peer validates only that `threadKey` is a non-empty string — it
 * stores and relays the offset for a card it does not know how to render,
 * rather than rejecting the merge.
 *
 * Presence is membership. An entry with live offsets means "this card is on
 * the map" (`0,0` = open at its default spot); the null-pair tombstone that
 * resets a thread card doubles as "closed" here. That is what makes the
 * load card appear on every instance in the fleet, since arrangement writes
 * already broadcast last-writer-wins.
 */
export const STAR_MAP_LOAD_CARD_KEY = "system:load";

/**
 * Where a load card sits, kept separate from whether it is shown.
 *
 * Membership and position cannot share one entry: closing a card has to
 * un-place it, and the only "absent" value an entry has is the null-pair
 * tombstone — which is also how a card forgets its offset. Sharing them made
 * closing a card destroy the spot the operator had dragged it to, so
 * reopening dumped it back on top of whatever sits at the default.
 */
export const STAR_MAP_LOAD_CARD_POSITION_KEY = "system:load:position";

export function starMapArrangementEntryKey(
  entry: Pick<StarMapArrangementEntry, "instanceId" | "threadKey">,
): string {
  return `${entry.instanceId} ${entry.threadKey}`;
}

export function isStarMapArrangementEntry(
  value: unknown,
): value is StarMapArrangementEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<StarMapArrangementEntry>;
  const offsetValid = (offset: unknown): offset is number | null =>
    offset === null || (typeof offset === "number" && Number.isFinite(offset));
  return (
    typeof candidate.instanceId === "string"
    && candidate.instanceId.length > 0
    && typeof candidate.threadKey === "string"
    && candidate.threadKey.length > 0
    && offsetValid(candidate.dx)
    && offsetValid(candidate.dy)
    // A half-tombstone is malformed; both offsets live or both die.
    && (candidate.dx === null) === (candidate.dy === null)
    && typeof candidate.updatedAt === "number"
    && Number.isFinite(candidate.updatedAt)
    && typeof candidate.by === "string"
    && candidate.by.length > 0
  );
}

/**
 * Merge incoming entries into the current arrangement, last-writer-wins per
 * card. Ties break on the writing instance id so replicas converge no
 * matter the merge order. Returns the accepted incoming entries so callers
 * can persist and re-broadcast deltas only.
 */
export function mergeStarMapArrangementEntries(
  current: readonly StarMapArrangementEntry[],
  incoming: readonly StarMapArrangementEntry[],
): {
  entries: StarMapArrangementEntry[];
  accepted: StarMapArrangementEntry[];
  changed: boolean;
} {
  const merged = new Map<string, StarMapArrangementEntry>();
  for (const entry of current) {
    merged.set(starMapArrangementEntryKey(entry), entry);
  }
  const accepted: StarMapArrangementEntry[] = [];
  for (const entry of incoming) {
    if (!isStarMapArrangementEntry(entry)) continue;
    const key = starMapArrangementEntryKey(entry);
    const existing = merged.get(key);
    if (existing && !arrangementEntryBeats(entry, existing)) {
      continue;
    }
    if (
      !existing
      || existing.dx !== entry.dx
      || existing.dy !== entry.dy
      || existing.updatedAt !== entry.updatedAt
      || existing.by !== entry.by
    ) {
      accepted.push(entry);
    }
    merged.set(key, entry);
  }
  return {
    entries: [...merged.values()],
    accepted,
    changed: accepted.length > 0,
  };
}

function arrangementEntryBeats(
  candidate: StarMapArrangementEntry,
  incumbent: StarMapArrangementEntry,
): boolean {
  if (candidate.updatedAt !== incumbent.updatedAt) {
    return candidate.updatedAt > incumbent.updatedAt;
  }
  return candidate.by > incumbent.by;
}

export type ReadStarMapArrangementResponse = {
  entries: StarMapArrangementEntry[];
};

export type SetStarMapCardPositionRequest = {
  instanceId: string;
  threadKey: string;
  /** null resets the card to its default slot (tombstone write). */
  dx: number | null;
  dy: number | null;
};

/* ==== Viewer-owned workspace ==== */

export const STAR_MAP_WORKSPACE_VERSION = 1 as const;
export const STAR_MAP_WORKSPACE_KEY = "default";

export type StarMapWorkspaceLayout = "lanes" | "orbit" | "projects";

export type StarMapWorkspaceRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type StarMapWorkspaceAnchor =
  | {
      kind: "thread";
      instanceId: string;
      threadKey: string;
    }
  | {
      kind: "instance";
      instanceId: string;
    }
  | { kind: "canvas" };

/**
 * The bounded part of a navigation row needed to paint and reconnect an open
 * chat before its owning instance has answered the first federation poll.
 * Transcript entries, tool output, PR history, and other growing collections
 * deliberately do not belong in this snapshot.
 */
export type StarMapWorkspaceThreadSnapshot = Pick<
  NavigationThreadSummary,
  "id" | "inbox" | "linkedDirectories" | "source" | "title" | "titleSource"
> &
  Partial<
    Pick<
      NavigationThreadSummary,
      | "createdAt"
      | "executionMode"
      | "fastMode"
      | "federation"
      | "forkSourceThreadId"
      | "model"
      | "primaryGitRepository"
      | "projectKey"
      | "reasoningEffort"
      | "serviceTier"
      | "updatedAt"
      | "workspaceHandoff"
    >
  >;

export type StarMapWorkspaceCard = {
  /** Fleet-qualified key; see `starMapWorkspaceCardKey`. */
  key: string;
  ownerInstanceId: string;
  thread: StarMapWorkspaceThreadSnapshot;
  geometry: {
    anchor: StarMapWorkspaceAnchor;
    dx: number;
    dy: number;
    /**
     * Separate owner-body basis for a thread card that is filtered, folded,
     * or unavailable on the next launch. Optional for version-1 rows written
     * before this fallback was recorded.
     */
    instanceDx?: number;
    instanceDy?: number;
    fallbackRect: StarMapWorkspaceRect;
  };
  contextOpen: boolean;
  terminalOpen: boolean;
  terminalHeight?: number;
};

export type StarMapWorkspaceView = {
  x: number;
  y: number;
  scale: number;
};

export type StarMapWorkspaceSnapshot = {
  version: typeof STAR_MAP_WORKSPACE_VERSION;
  /** Lowest first, highest/front-most last. */
  cards: StarMapWorkspaceCard[];
  views: Partial<Record<StarMapWorkspaceLayout, StarMapWorkspaceView>>;
};

export type StarMapWorkspaceState = StarMapWorkspaceSnapshot & {
  revision: number;
  updatedAt: number;
};

export type ReadStarMapWorkspaceResponse = {
  workspace: StarMapWorkspaceState;
};

export type WriteStarMapWorkspaceRequest = {
  /** Revision returned by the read or previous successful write. */
  baseRevision: number;
  workspace: StarMapWorkspaceSnapshot;
};

export function emptyStarMapWorkspaceState(): StarMapWorkspaceState {
  return {
    version: STAR_MAP_WORKSPACE_VERSION,
    cards: [],
    views: {},
    revision: 0,
    updatedAt: 0,
  };
}

export function starMapWorkspaceCardKey(params: {
  instanceId: string;
  threadKey: string;
}): string {
  return `${params.instanceId}::${params.threadKey}`;
}

export function snapshotStarMapWorkspaceThread(
  thread: NavigationThreadSummary,
): StarMapWorkspaceThreadSnapshot {
  return {
    id: thread.id,
    inbox: thread.inbox,
    linkedDirectories: thread.linkedDirectories.slice(0, 32),
    source: thread.source,
    title: thread.title.slice(0, 512),
    titleSource: thread.titleSource,
    createdAt: thread.createdAt,
    executionMode: thread.executionMode,
    fastMode: thread.fastMode,
    federation: thread.federation,
    forkSourceThreadId: thread.forkSourceThreadId,
    model: thread.model,
    primaryGitRepository: thread.primaryGitRepository,
    projectKey: thread.projectKey,
    reasoningEffort: thread.reasoningEffort,
    serviceTier: thread.serviceTier,
    updatedAt: thread.updatedAt,
    workspaceHandoff: thread.workspaceHandoff,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStarMapWorkspaceRect(value: unknown): value is StarMapWorkspaceRect {
  if (!value || typeof value !== "object") return false;
  const rect = value as Partial<StarMapWorkspaceRect>;
  return (
    isFiniteNumber(rect.left)
    && isFiniteNumber(rect.top)
    && isFiniteNumber(rect.width)
    && rect.width > 0
    && isFiniteNumber(rect.height)
    && rect.height > 0
  );
}

function isStarMapWorkspaceAnchor(
  value: unknown,
): value is StarMapWorkspaceAnchor {
  if (!value || typeof value !== "object") return false;
  const anchor = value as Partial<StarMapWorkspaceAnchor> & {
    instanceId?: unknown;
    threadKey?: unknown;
  };
  if (anchor.kind === "canvas") return true;
  if (
    (anchor.kind === "instance" || anchor.kind === "thread")
    && typeof anchor.instanceId === "string"
    && anchor.instanceId.length > 0
  ) {
    return anchor.kind === "instance"
      || (typeof anchor.threadKey === "string" && anchor.threadKey.length > 0);
  }
  return false;
}

function isStarMapWorkspaceThreadSnapshot(
  value: unknown,
): value is StarMapWorkspaceThreadSnapshot {
  if (!value || typeof value !== "object") return false;
  const thread = value as Partial<StarMapWorkspaceThreadSnapshot>;
  return (
    typeof thread.id === "string"
    && thread.id.length > 0
    && typeof thread.source === "string"
    && thread.source.length > 0
    && typeof thread.title === "string"
    && typeof thread.titleSource === "string"
    && Array.isArray(thread.linkedDirectories)
    && thread.linkedDirectories.length <= 32
    && Boolean(thread.inbox && typeof thread.inbox === "object")
  );
}

function isStarMapWorkspaceCard(value: unknown): value is StarMapWorkspaceCard {
  if (!value || typeof value !== "object") return false;
  const card = value as Partial<StarMapWorkspaceCard>;
  const geometry = card.geometry as
    | Partial<StarMapWorkspaceCard["geometry"]>
    | undefined;
  const hasInstanceOffset =
    geometry?.instanceDx !== undefined || geometry?.instanceDy !== undefined;
  if (
    typeof card.key !== "string"
    || typeof card.ownerInstanceId !== "string"
    || card.ownerInstanceId.length === 0
    || !isStarMapWorkspaceThreadSnapshot(card.thread)
    || !geometry
    || !isStarMapWorkspaceAnchor(geometry.anchor)
    || !isFiniteNumber(geometry.dx)
    || !isFiniteNumber(geometry.dy)
    || (hasInstanceOffset
      && (
        !isFiniteNumber(geometry.instanceDx)
        || !isFiniteNumber(geometry.instanceDy)
      ))
    || !isStarMapWorkspaceRect(geometry.fallbackRect)
    || typeof card.contextOpen !== "boolean"
    || typeof card.terminalOpen !== "boolean"
    || (card.terminalHeight !== undefined
      && (!isFiniteNumber(card.terminalHeight) || card.terminalHeight <= 0))
  ) {
    return false;
  }
  return card.key === starMapWorkspaceCardKey({
    instanceId: card.ownerInstanceId,
    threadKey: buildThreadKey(card.thread),
  });
}

function buildThreadKey(thread: StarMapWorkspaceThreadSnapshot): string {
  return `${thread.source}:${thread.id}`;
}

function isStarMapWorkspaceView(value: unknown): value is StarMapWorkspaceView {
  if (!value || typeof value !== "object") return false;
  const view = value as Partial<StarMapWorkspaceView>;
  return (
    isFiniteNumber(view.x)
    && isFiniteNumber(view.y)
    && isFiniteNumber(view.scale)
    && view.scale > 0
  );
}

/**
 * Decode a stored workspace defensively. A corrupt card or lens camera is
 * omitted without taking the operator's remaining desk state with it.
 */
export function parseStarMapWorkspaceSnapshot(
  value: unknown,
): StarMapWorkspaceSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const snapshot = value as Partial<StarMapWorkspaceSnapshot>;
  if (
    snapshot.version !== STAR_MAP_WORKSPACE_VERSION
    || !Array.isArray(snapshot.cards)
    || snapshot.cards.length > 256
    || !snapshot.views
    || typeof snapshot.views !== "object"
  ) {
    return undefined;
  }
  const keys = new Set<string>();
  const cards: StarMapWorkspaceCard[] = [];
  for (const card of snapshot.cards) {
    if (!isStarMapWorkspaceCard(card) || keys.has(card.key)) continue;
    keys.add(card.key);
    cards.push(card);
  }
  const views: StarMapWorkspaceSnapshot["views"] = {};
  for (const layout of ["lanes", "orbit", "projects"] as const) {
    const view = snapshot.views[layout];
    if (isStarMapWorkspaceView(view)) views[layout] = view;
  }
  return { version: STAR_MAP_WORKSPACE_VERSION, cards, views };
}

export function isStarMapWorkspaceSnapshot(
  value: unknown,
): value is StarMapWorkspaceSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<StarMapWorkspaceSnapshot>;
  if (
    snapshot.version !== STAR_MAP_WORKSPACE_VERSION
    || !Array.isArray(snapshot.cards)
    || snapshot.cards.length > 256
    || !snapshot.cards.every(isStarMapWorkspaceCard)
    || !snapshot.views
    || typeof snapshot.views !== "object"
  ) {
    return false;
  }
  const keys = new Set(snapshot.cards.map((card) => card.key));
  if (keys.size !== snapshot.cards.length) return false;
  for (const layout of ["lanes", "orbit", "projects"] as const) {
    const view = snapshot.views[layout];
    if (!view) continue;
    if (!isStarMapWorkspaceView(view)) return false;
  }
  return true;
}

/* ==== AI intake ==== */

export type StarMapIntakeCandidate = {
  directoryKey: string;
  label: string;
  path?: string;
};

/**
 * A PwrAgent-owned staged attachment supplied with a Star Map intake task.
 * Federation replaces the sender-local path with a receiver-local path after
 * transferring the binary payload outside the JSON-RPC envelope.
 */
export type StarMapIntakeAttachment = {
  type: "localImage" | "localFile";
  name?: string;
  path: string;
};

/**
 * Intake dispatch, executed ON the owning instance so its directory
 * registry, launchpad defaults, and ~/.pwragent/AGENTS.md preferences are
 * the ones consulted. `directoryKey` is set on a disambiguation resubmit.
 *
 * Backend/thread ids are plain strings here (not the normalized app-server
 * types) so this contract stays leaf-importable without a type cycle.
 */
export type StarMapIntakeRequest = {
  requestId: string;
  request: string;
  directoryKey?: string;
  attachments?: StarMapIntakeAttachment[];
};

export type StarMapIntakeResponse =
  | {
      status: "created";
      requestId: string;
      backend: string;
      threadId: string;
      title?: string;
    }
  | {
      status: "needs_disambiguation";
      requestId: string;
      /** Ranked candidate projects for the operator to pick from. */
      candidates: StarMapIntakeCandidate[];
    }
  | {
      status: "failed";
      requestId: string;
      error: string;
    };

export type StarMapIntakePhase =
  | "resolving"
  | "creating"
  | "needs_disambiguation"
  | "done"
  | "failed";

/**
 * The Star Map manager thread: one long-lived thread per instance that the
 * operator talks to about the map itself.
 *
 * It is an ordinary thread — it gets the same PwrAgent tool catalog every
 * thread gets, including `mutate_thread` and the orchestration tools, plus
 * `read_star_map_view`, which lets it see what is on screen. What makes it
 * the manager is where it is remembered and the persona it starts with, not
 * a privileged execution path.
 */
export type OpenStarMapManagerRequest = {
  /** Start fresh rather than reopening the remembered thread. */
  reset?: boolean;
};

export type OpenStarMapManagerResponse =
  | {
      status: "ready";
      backend: string;
      threadId: string;
      /** False when the remembered thread was reopened. */
      created: boolean;
    }
  | {
      status: "failed";
      error: string;
    };

/** Title given to a freshly created manager thread. */
export const STAR_MAP_MANAGER_THREAD_TITLE = "Star Map manager";

export const STAR_MAP_MANAGER_AGENT_NAME = "Star Map manager";

/**
 * The manager's persona. Deliberately narrow: it exists to act on what the
 * operator can see, and the failure mode that matters is acting on the
 * wrong thread — so it is told to look before it acts, and to say what it
 * is about to touch when a request covers more than one card.
 */
export const STAR_MAP_MANAGER_AGENT_INSTRUCTIONS = [
  "You are the PwrAgent Star Map manager. The operator talks to you from a",
  "chat card floating over the Star Map — a view of every thread across",
  "their federated PwrAgent instances, drawn as cards grouped into labelled",
  "clouds around each instance.",
  "",
  "Call read_star_map_view before acting on anything the operator points at.",
  "References like \"that thread\", \"this cloud\", \"the selected cards\" or",
  "\"the ones like it\" can only be resolved against the live view: it reports",
  "the clouds and their membership, which cards are drawn versus folded",
  "behind a `+N more` chip, what the operator has selected, and the backend,",
  "threadId and instanceId each tool call needs.",
  "",
  "Act with the PwrAgent tools you already have — mutate_thread to retitle,",
  "the orchestration tools to steer, move or review.",
  "",
  "When a request covers several threads, say which ones you are about to",
  "change and what the change is before you make it. Renaming twelve threads",
  "the operator did not mean is far worse than asking once. Threads on other",
  "instances are real threads on someone's machine: name the instance when",
  "you are about to touch one.",
].join("\n");
