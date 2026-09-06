import type {
  NavigationIdentity,
  NavigationQueryEntry,
  NavigationQueryPage,
  NavigationQueryRequest,
  NavigationSelectedDetailResponse,
} from "@pwragent/shared";

/** One resource's loaded range; it never represents the owner's population. */
export type NavigationPageState = {
  request: NavigationQueryRequest;
  page?: NavigationQueryPage;
  pendingSequence: number;
  stale: boolean;
  error?: string;
};

/** Exact identity authority is independent of all collection pages. */
export type NavigationSelectionState = {
  ref: NavigationIdentity;
  pendingSequence: number;
  readiness: "loading" | "ready" | "failed";
  detail?: NavigationSelectedDetailResponse;
  error?: string;
};

export function navigationIdentityKey(ref: NavigationIdentity): string {
  return JSON.stringify([ref.ownerInstanceId ?? null, ref.backend, ref.threadId]);
}

export function createNavigationPageState(request: NavigationQueryRequest): NavigationPageState {
  return { request, pendingSequence: 0, stale: false };
}

export function beginNavigationPageRead(state: NavigationPageState): NavigationPageState {
  return { ...state, pendingSequence: state.pendingSequence + 1, error: undefined };
}

function mergeEntries(
  previous: readonly NavigationQueryEntry[],
  incoming: readonly NavigationQueryEntry[],
): NavigationQueryEntry[] {
  const byIdentity = new Map(previous.map((entry) => [navigationIdentityKey(entry.row.ref), entry]));
  for (const entry of incoming) byIdentity.set(navigationIdentityKey(entry.row.ref), entry);
  return [...byIdentity.values()];
}

/** A continuation can extend only the precise generation that requested it. */
export function applyNavigationPage(params: {
  state: NavigationPageState;
  sequence: number;
  page: NavigationQueryPage;
  cursor?: string;
}): NavigationPageState {
  const { state, page, sequence, cursor } = params;
  if (sequence !== state.pendingSequence) return state;
  if (page.protocol !== 2) throw new Error("Navigation query protocol 2 is required. Upgrade the owning instance.");
  if (page.complete === Boolean(page.nextCursor)) {
    throw new Error("Navigation page has inconsistent continuation readiness.");
  }
  const previous = state.page;
  if (page.unchanged) {
    if (!previous?.complete || cursor || page.queryKey !== previous.queryKey
      || page.countsRevision !== previous.countsRevision || page.ownerEpoch !== previous.ownerEpoch) {
      throw new Error("Navigation unchanged response has no complete matching baseline.");
    }
    return { ...state, stale: false, error: undefined };
  }
  if (cursor) {
    if (!previous || previous.nextCursor !== cursor || previous.queryKey !== page.queryKey
      || previous.generation !== page.generation || previous.ownerEpoch !== page.ownerEpoch
      || previous.countsRevision !== page.countsRevision) {
      throw new Error("Navigation continuation does not match its loaded generation.");
    }
    if (page.nextCursor === cursor) throw new Error("Navigation continuation did not advance.");
    const directories = new Map((previous.directories ?? []).map((directory) => [directory.key, directory]));
    for (const directory of page.directories ?? []) directories.set(directory.key, directory);
    return {
      ...state,
      stale: false,
      error: undefined,
      page: {
        ...page,
        entries: mergeEntries(previous.entries, page.entries),
        ...(previous.directories || page.directories ? { directories: [...directories.values()] } : {}),
      },
    };
  }
  return { ...state, page, stale: false, error: undefined };
}

export function failNavigationPageRead(
  state: NavigationPageState,
  sequence: number,
  error: unknown,
): NavigationPageState {
  if (sequence !== state.pendingSequence) return state;
  return { ...state, stale: Boolean(state.page), error: error instanceof Error ? error.message : String(error) };
}

export function selectNavigationIdentity(
  current: NavigationSelectionState | undefined,
  ref: NavigationIdentity,
): NavigationSelectionState {
  return {
    ref,
    pendingSequence: (current?.pendingSequence ?? 0) + 1,
    readiness: "loading",
    ...(current && navigationIdentityKey(current.ref) === navigationIdentityKey(ref)
      ? { detail: current.detail }
      : {}),
  };
}

export function applyNavigationSelectedDetail(params: {
  state: NavigationSelectionState;
  sequence: number;
  detail: NavigationSelectedDetailResponse;
}): NavigationSelectionState {
  const { state, sequence, detail } = params;
  if (sequence !== state.pendingSequence) return state;
  if (detail.protocol !== 2 || navigationIdentityKey(detail.ref) !== navigationIdentityKey(state.ref)) {
    throw new Error("Selected detail does not match the requested owner and thread.");
  }
  if (detail.unchanged) {
    if (!state.detail || state.detail.revision !== detail.revision) {
      throw new Error("Selected detail unchanged response has no matching baseline.");
    }
    return { ...state, readiness: state.detail.readiness, error: undefined };
  }
  if (detail.thread && (detail.thread.source !== state.ref.backend || detail.thread.id !== state.ref.threadId)) {
    throw new Error("Selected configuration belongs to another thread.");
  }
  if (detail.readiness === "ready" && detail.identity === "present" && !detail.thread) {
    throw new Error("Selected thread configuration is not ready.");
  }
  return { ...state, detail, readiness: detail.readiness, error: undefined };
}
