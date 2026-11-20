import {
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useMemo,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { buildThreadIdentityKey, type NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { isRemoteFederationTarget } from "@pwragent/shared/contracts/federation";
import {
  parseThreadSearchQuery,
  threadSearchTextTerms,
  matchesThreadSearchProjects,
} from "@pwragent/shared/thread-search-query";
import { type AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import { type MessagingChannelKind } from "@pwragent/shared/contracts/messaging";
import {
  type ThreadSearchMatchReasonKind,
  type ThreadSearchRemoteInstance,
  type ThreadSearchResponse,
  type ThreadSearchResult,
} from "@pwragent/shared/contracts/thread-search";
import type { DesktopApi } from "../../lib/desktop-api";
import type { HistoryNavControls } from "../chrome/HistoryNavButtons";
import type { MastheadActionsProps } from "../chrome/MastheadActions";
import { ThreadPlaceholderHeader } from "../thread-detail/ThreadPlaceholderHeader";
import { AgentThreadChip } from "../navigation/AgentThreadChip";
import { InstanceChip } from "../federation/InstanceGlyph";
import { useProviderChipNeeded } from "../navigation/provider-chip-visibility";
import { useThreadProviderLabel } from "../../lib/thread-provider-label";
import { formatFullTimestamp, formatRelativeTime } from "../navigation/thread-time";
import { ProjectSearchInput } from "./ProjectSearchInput";
import { mergeAgentMatches, mergePrNumberMatches } from "./thread-match";
import { BranchIcon, FolderIcon, PopoutIcon, SearchIcon, WorktreeIcon } from "../../icons";

/** Result order: the search's own ranking, or the latest activity first. */
export type ThreadSearchSort = "relevance" | "latest";

type ThreadSearchPanelSnapshot = {
  query: string;
  response: ThreadSearchResponse | undefined;
  sort: ThreadSearchSort;
  /**
   * A search asked for from outside the panel (⌘K's "search all") that has
   * not produced a response yet. A new object per request, so asking again
   * runs again.
   */
  searchRequest: object | undefined;
};

/**
 * The query, results and sort order, liftable above the panel. The panel
 * unmounts whenever the operator opens a result (mainView flips to "thread"),
 * so App owns an instance of this state — that's what lets history Back land
 * on a still-populated results list instead of a blank search form.
 *
 * It is a store, not React state, so its owner does not render when it
 * changes: App holds it, and a keystroke in the search field must not render
 * App. Only the panel subscribes.
 */
export type ThreadSearchPanelState = {
  getSnapshot: () => ThreadSearchPanelSnapshot;
  subscribe: (listener: () => void) => () => void;
  setQuery: (query: string) => void;
  setResponse: (response: ThreadSearchResponse | undefined) => void;
  setSort: (sort: ThreadSearchSort) => void;
  /** Puts `query` in the field and has the panel run it, now or when it mounts. */
  requestSearch: (query: string) => void;
  settleSearchRequest: () => void;
};

export function createThreadSearchPanelState(): ThreadSearchPanelState {
  let snapshot: ThreadSearchPanelSnapshot = {
    query: "",
    response: undefined,
    sort: "relevance",
    searchRequest: undefined,
  };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<ThreadSearchPanelSnapshot>): void => {
    const next = { ...snapshot, ...patch };
    if (
      next.query === snapshot.query
      && next.response === snapshot.response
      && next.sort === snapshot.sort
      && next.searchRequest === snapshot.searchRequest
    ) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setQuery: (query) => update({ query }),
    setResponse: (response) => update({ response }),
    setSort: (sort) => update({ sort }),
    requestSearch: (query) => update({ query, searchRequest: {} }),
    settleSearchRequest: () => update({ searchRequest: undefined }),
  };
}

export function useThreadSearchPanelState(): ThreadSearchPanelState {
  return useState(createThreadSearchPanelState)[0];
}

type RemoteViewerFederation = NonNullable<ThreadSearchResult["federation"]>;

type ThreadSearchPanelProps = {
  desktopApi?: DesktopApi;
  onOpenResult: (result: {
    backend: AppServerBackendKind;
    federation?: ThreadSearchResult["federation"];
    threadId: string;
    /** Turn of the matched message, for deep-linking to it in the thread. */
    turnId?: string;
  }) => Promise<void> | void;
  /**
   * Opens a remote result in its owner's remote viewer window. Only the
   * main window passes it: there a click shows the remote thread in place,
   * so the other window is a separate, labelled choice on the card.
   */
  onOpenResultInRemoteViewer?: (
    federation: RemoteViewerFederation,
  ) => Promise<void> | void;
  onOpenMessagingActivity?: (platform?: MessagingChannelKind) => void;
  onOpenMessagingSettings?: () => void;
  /**
   * Close the search screen (Escape). App routes this to history back so it
   * pops the search entry off the stack and returns to wherever you came from,
   * matching the title-bar Back button. Fires even with a typed query.
   */
  onClose?: () => void;
  /**
   * Window panel toggles + relocated masthead, threaded straight through to
   * the shared {@link ThreadPlaceholderHeader} so search wears the same title
   * bar as the thread view — the MSG status, the sidebar toggle, and the
   * (disabled) rail toggle stay put instead of vanishing behind a bespoke
   * header. Optional so the component still renders bare in unit tests.
   */
  layout?: {
    sidebarOpen: boolean;
    railOpen: boolean;
    onToggleSidebar: () => void;
    onToggleRail: () => void;
  };
  masthead?: MastheadActionsProps;
  /** Back/Forward pair for the title bar, forwarded to the header. */
  history?: HistoryNavControls;
  /**
   * The full navigation thread list, used to resolve bare PR-number queries
   * ("#779" / "779") and Agent metadata. Those aren't in the FTS index, so
   * the matches are merged in client-side.
   */
  threads?: readonly NavigationThreadSummary[];
  /**
   * Lifted query/results state (see {@link useThreadSearchPanelState}).
   * Optional so the component still renders self-contained in unit tests;
   * App supplies it so results survive opening a result.
   */
  state?: ThreadSearchPanelState;
};

const MATCH_REASON_LABELS: Record<ThreadSearchMatchReasonKind, string> = {
  exact_title: "Exact title",
  title_token_overlap: "Title match",
  summary_match: "Summary match",
  project_match: "Project match",
  directory_match: "Directory match",
  path_match: "Path match",
  branch_match: "Branch match",
  thread_id_match: "Thread ID match",
  backend_match: "Backend match",
  model_match: "Model match",
  pr_number_match: "PR match",
  agent_match: "Agent match",
  time_filter: "Recent",
  archive_filter: "Archived",
  provider_content_match: "Message content",
  semantic_match: "Semantic match",
  recent_activity: "Recent activity",
};

function describeMatchReason(kind: ThreadSearchMatchReasonKind | undefined): string {
  if (!kind) {
    return "Match";
  }
  return MATCH_REASON_LABELS[kind] ?? kind.replaceAll("_", " ");
}

export function basename(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
}

/**
 * Wrap each query token where it appears in a snippet so the matched text
 * reads as a tangerine highlight instead of a flat gray run. React owns the
 * escaping; we only split on literal, regex-escaped tokens.
 */
export function highlightSnippet(text: string, query: string): ReactNode[] {
  const tokens = Array.from(
    new Set(
      threadSearchTextTerms(query)
        .map((term) => term.text.toLowerCase())
        .filter((token) => token.length >= 2),
    ),
  ).sort((a, b) => b.length - a.length);
  if (tokens.length === 0) {
    return [text];
  }
  const escaped = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const splitter = new RegExp(`(${escaped.join("|")})`, "ig");
  const tokenSet = new Set(tokens);
  return text
    .split(splitter)
    .filter((part) => part.length > 0)
    .map((part, index) =>
      tokenSet.has(part.toLowerCase()) ? (
        <mark key={index} className="thread-search-result__mark">
          {part}
        </mark>
      ) : (
        <span key={index}>{part}</span>
      ),
    );
}

// One timer for every age label on screen, running only while one is.
const minuteListeners = new Set<() => void>();
let minuteTimer: number | undefined;
let minute = 0;

function subscribeToMinutes(listener: () => void): () => void {
  minuteListeners.add(listener);
  minuteTimer ??= window.setInterval(() => {
    minute += 1;
    for (const notify of minuteListeners) notify();
  }, 60_000);
  return () => {
    minuteListeners.delete(listener);
    if (minuteListeners.size === 0 && minuteTimer !== undefined) {
      window.clearInterval(minuteTimer);
      minuteTimer = undefined;
    }
  };
}

/**
 * The sidebar row's age label; hover gives the date with its year. The cards
 * are memoized, so the label renders itself once a minute to stay true while
 * the results stay open.
 */
function ThreadSearchResultTime(props: { timestamp: number }): ReactElement {
  useSyncExternalStore(subscribeToMinutes, () => minute);
  return (
    <span
      className="thread-search-result__time tooltip-target"
      data-tooltip={formatFullTimestamp(props.timestamp)}
    >
      {formatRelativeTime(props.timestamp)}
    </span>
  );
}

const CONFIDENCE_LABELS: Record<ThreadSearchResult["confidence"], string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

/**
 * One result: its card, and beside it the Remote viewer button when
 * `onOpenRemoteViewer` is given and another machine owns the thread.
 * Memoized, with stable callbacks, so typing in the search field or a
 * navigation update renders no card.
 */
const ThreadSearchResultItem = memo(function ThreadSearchResultItem(props: {
  result: ThreadSearchResult;
  isAgent: boolean;
  /** The thread's last activity, as the sidebar row prints it. */
  timestamp: number | undefined;
  query: string;
  onOpen: (result: ThreadSearchResult) => void;
  onOpenRemoteViewer?: (federation: RemoteViewerFederation) => void;
}): ReactElement {
  const { result, query, timestamp } = props;
  const showProvider = useProviderChipNeeded(result.backend, result.model);
  const providerLabel = useThreadProviderLabel({
    source: result.backend,
    model: result.model,
    federation: result.federation,
  });
  // A result owned by another machine, in a window that shows such results
  // in place, gets a Remote viewer button.
  const remoteViewerFederation =
    props.onOpenRemoteViewer
    && result.federation
    && isRemoteFederationTarget(result.federation.ref.target)
      ? result.federation
      : undefined;
  const directory = result.linkedDirectories[0];
  // `projectKey` is often a full checkout/worktree path (Codex keys projects by
  // cwd), so collapse whatever we resolve down to its final path segment — the
  // repo folder — and let the branch carry the distinguishing detail. `||`
  // (not `??`) so an empty-string projectKey falls through to the directory.
  const rawWorkspace = result.projectKey || directory?.label || directory?.path;
  const workspaceLabel = rawWorkspace ? basename(rawWorkspace) : undefined;
  const WorkspaceIcon = directory?.kind === "worktree" ? WorktreeIcon : FolderIcon;
  const titleNormalized = result.title.trim().toLowerCase();
  const snippet = result.snippets.find(
    (entry) => entry.text.trim().toLowerCase() !== titleNormalized,
  )?.text;

  return (
    <div className="thread-search-results__item" role="listitem">
      <button
        className="thread-search-result"
        type="button"
        onClick={() => props.onOpen(result)}
      >
        <span className="thread-search-result__body">
          <span className="thread-search-result__title">{result.title}</span>
          <span className="thread-search-result__meta">
            {showProvider ? (
              <span className="chip chip--backend">{providerLabel}</span>
            ) : null}
            {props.isAgent ? <AgentThreadChip /> : null}
            {result.federation ? (
              <InstanceChip
                instanceId={
                  result.federation.ref.target.scope === "remote"
                    ? result.federation.ref.target.instanceId
                    : ""
                }
                label={result.federation.instanceLabel}
              />
            ) : null}
            {workspaceLabel ? (
              <span className="thread-search-result__meta-item">
                <WorkspaceIcon size={13} aria-hidden />
                <span className="thread-search-result__meta-text">{workspaceLabel}</span>
              </span>
            ) : null}
            {result.gitBranch ? (
              <span className="thread-search-result__meta-item thread-search-result__meta-item--mono">
                <BranchIcon size={13} aria-hidden />
                <span className="thread-search-result__meta-text">{result.gitBranch}</span>
              </span>
            ) : null}
            {result.model ? (
              <span className="thread-search-result__meta-item thread-search-result__meta-item--mono thread-search-result__meta-item--muted">
                <span className="thread-search-result__meta-text">{result.model}</span>
              </span>
            ) : null}
          </span>
          {snippet ? (
            <span className="thread-search-result__snippet">{highlightSnippet(snippet, query)}</span>
          ) : null}
        </span>
        <span className="thread-search-result__side">
          {timestamp !== undefined ? <ThreadSearchResultTime timestamp={timestamp} /> : null}
          <span
            className={`thread-search-result__reason thread-search-result__reason--${result.confidence} tooltip-target`}
            data-tooltip={CONFIDENCE_LABELS[result.confidence]}
          >
            <span className="thread-search-result__confidence-dot" aria-hidden />
            {describeMatchReason(result.matchReasons[0]?.kind)}
            {/* The tooltip opens for a pointer only; this puts the band in
                the card's name for a keyboard or a screen reader. */}
            <span className="thread-search-result__sr">
              {`, ${CONFIDENCE_LABELS[result.confidence].toLowerCase()}`}
            </span>
          </span>
          {remoteViewerFederation ? (
            // Holds the corner the sibling Remote viewer button covers: the
            // snippet wraps before it, and a card without a snippet still has
            // room for it.
            <span
              aria-hidden
              className="thread-search-result__popout thread-search-result__popout--slot"
            >
              <PopoutIcon size={12} strokeWidth={2.2} />
              Remote viewer
            </span>
          ) : null}
        </span>
      </button>
      {remoteViewerFederation && props.onOpenRemoteViewer ? (
        <ThreadSearchRemoteViewerButton
          federation={remoteViewerFederation}
          onOpen={props.onOpenRemoteViewer}
        />
      ) : null}
    </div>
  );
});

/**
 * Opens a remote result in its owner's remote viewer window. It sits beside
 * the result's card, since a <button> cannot nest in the card's <button>,
 * and is pinned over the card's bottom-right corner, which the card's hidden
 * copy of it holds open.
 */
function ThreadSearchRemoteViewerButton(props: {
  federation: RemoteViewerFederation;
  onOpen: (federation: RemoteViewerFederation) => void;
}): ReactElement {
  const { federation, onOpen } = props;
  // The name keeps the visible label (WCAG 2.5.3) and adds the machine; the
  // tooltip, which DataTooltipLayer also hands to assistive tech as the
  // description, says what happens.
  return (
    <button
      aria-label={`Remote viewer for ${federation.instanceLabel}`}
      className="thread-search-result__popout tooltip-target"
      data-tooltip={`Open in the ${federation.instanceLabel} window`}
      type="button"
      onClick={() => onOpen(federation)}
    >
      <PopoutIcon size={12} strokeWidth={2.2} aria-hidden />
      Remote viewer
    </button>
  );
}

function describeRemoteInstance(instance: ThreadSearchRemoteInstance): string {
  if (instance.failed) return `${instance.instanceLabel} unavailable`;
  if (instance.cancelled) return `${instance.instanceLabel} stopped`;
  if (instance.searching) return `${instance.instanceLabel} searching`;
  return `${instance.instanceLabel} (${instance.resultCount})`;
}

/**
 * Discloses remote-search scope: which connected instances contributed
 * and whether an owner is still searching. `summary` names only the
 * instances that have something to report — results, a search still
 * running, a failure — and counts the ones that finished with no match;
 * `detail` lists every instance, for the tooltip.
 */
export function describeRemoteInstances(
  instances: ThreadSearchRemoteInstance[],
): { summary: string; detail: string } {
  const detail = `Remote: ${instances.map(describeRemoteInstance).join(", ")}`;
  const notable = instances.filter((instance) =>
    instance.failed || instance.cancelled || instance.searching || instance.resultCount > 0);
  const quiet = instances.length - notable.length;
  const noun = (count: number): string => (count === 1 ? "instance" : "instances");
  if (notable.length === 0) {
    return { summary: `Remote: no matches on ${quiet} ${noun(quiet)}`, detail };
  }
  const named = notable.map(describeRemoteInstance).join(", ");
  return {
    summary: quiet > 0
      ? `Remote: ${named}, no matches on ${quiet} other ${noun(quiet)}`
      : `Remote: ${named}`,
    detail,
  };
}

/** A result's last activity as the search returned it. */
function resultTimestamp(
  result: Pick<ThreadSearchResult, "updatedAt" | "createdAt">,
): number | undefined {
  return result.updatedAt ?? result.createdAt;
}

/**
 * The results in the chosen order. "Best match" is the search's own ranking.
 * "Latest" puts the most recent activity first, keeps the ranking between
 * results of the same age, and puts results with no time last.
 */
export function orderThreadSearchResults<
  Result extends Pick<ThreadSearchResult, "updatedAt" | "createdAt">,
>(results: readonly Result[], sort: ThreadSearchSort): readonly Result[] {
  if (sort === "relevance") return results;
  return results.toSorted((left, right) =>
    (resultTimestamp(right) ?? 0) - (resultTimestamp(left) ?? 0));
}

function stoppedResponse(response: ThreadSearchResponse): ThreadSearchResponse {
  return {
    ...response,
    remoteInstances: response.remoteInstances?.map((instance) =>
      instance.searching ? { ...instance, searching: false, cancelled: true } : instance),
  };
}

function ThreadSearchEmptyState(props: {
  title: string;
  hint: string;
}): ReactElement {
  return (
    <div className="thread-search-empty">
      <span className="thread-search-empty__glyph" aria-hidden>
        <SearchIcon size={22} />
      </span>
      <p className="thread-search-empty__title">{props.title}</p>
      <p className="thread-search-empty__hint">{props.hint}</p>
    </div>
  );
}

/**
 * The search field and its buttons. It alone subscribes to the typed query,
 * so typing renders this form and not the title bar or the results.
 */
function ThreadSearchForm(props: {
  state: ThreadSearchPanelState;
  desktopApi?: DesktopApi;
  loading: boolean;
  searchUnavailable: boolean;
  helpOpen: boolean;
  helpId: string;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
  onToggleHelp: () => void;
}): ReactElement {
  const { state } = props;
  const query = useSyncExternalStore(state.subscribe, () => state.getSnapshot().query);
  return (
    <form className="thread-search__form" onSubmit={props.onSubmit}>
      <ProjectSearchInput value={query} onChange={state.setQuery} desktopApi={props.desktopApi} />
      <button
        className="button button--primary thread-search__submit"
        disabled={!query.trim() || props.searchUnavailable}
        type="submit"
      >
        <SearchIcon size={15} aria-hidden />
        <span>{props.loading ? "Searching" : "Search"}</span>
      </button>
      {props.loading ? (
        <button className="button button--secondary" type="button" onClick={props.onCancel}>
          Stop
        </button>
      ) : null}
      <button
        className="button"
        type="button"
        aria-label="Search help"
        aria-expanded={props.helpOpen}
        aria-controls={props.helpId}
        onClick={props.onToggleHelp}
      >
        ?
      </button>
    </form>
  );
}

export function ThreadSearchPanel(props: ThreadSearchPanelProps) {
  const localState = useThreadSearchPanelState();
  const store = props.state ?? localState;
  const { setResponse, setSort } = store;
  // The panel reads the results and their order; only the form reads the
  // typed query, so a keystroke renders the form and nothing else here.
  const response = useSyncExternalStore(store.subscribe, () => store.getSnapshot().response);
  const sort = useSyncExternalStore(store.subscribe, () => store.getSnapshot().sort);
  const [helpOpen, setHelpOpen] = useState(false);
  const helpId = useId();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [cancelled, setCancelled] = useState(false);
  const searchGeneration = useRef(0);
  const searching = useRef(false);
  const lastResponse = useRef(response);
  lastResponse.current = response;
  const api = props.desktopApi;
  useEffect(() => () => {
    searchGeneration.current += 1;
    if (searching.current) {
      if (lastResponse.current) setResponse(stoppedResponse(lastResponse.current));
      void api?.cancelThreadSearch?.().catch(() => undefined);
    }
  }, [api, setResponse]);

  const searchUnavailable = !props.desktopApi?.searchThreads;
  // App passes new handler functions on every render. The cards get stable
  // ones that read the latest, so a render of App renders no card.
  const onOpenResultRef = useRef(props.onOpenResult);
  onOpenResultRef.current = props.onOpenResult;
  const onOpenRemoteViewerRef = useRef(props.onOpenResultInRemoteViewer);
  onOpenRemoteViewerRef.current = props.onOpenResultInRemoteViewer;
  const openResult = useCallback((result: ThreadSearchResult): void => {
    void onOpenResultRef.current({
      backend: result.backend,
      ...(result.federation ? { federation: result.federation } : {}),
      threadId: result.threadId,
      turnId: result.snippets.find((snippet) => snippet.turnId)?.turnId,
    });
  }, []);
  const openRemoteViewer = useCallback((federation: RemoteViewerFederation): void => {
    void onOpenRemoteViewerRef.current?.(federation);
  }, []);
  const showsRemoteViewer = Boolean(props.onOpenResultInRemoteViewer);
  // What the sidebar knows about the threads in the results: whether each is
  // an Agent, and its current last-activity time, which can be later than
  // the one the search returned.
  const results = response?.results;
  const liveThreads = useMemo(() => {
    const live = new Map<string, { isAgent: boolean; updatedAt: number | undefined }>();
    if (!results?.length || !props.threads) return live;
    const wanted = new Set(results.map((result) => result.identityKey));
    for (const thread of props.threads) {
      const key = buildThreadIdentityKey(thread.source, thread.id);
      if (wanted.has(key)) {
        live.set(key, { isAgent: Boolean(thread.agent), updatedAt: thread.updatedAt });
      }
    }
    return live;
  }, [props.threads, results]);
  // "Latest" orders by the times the search returned, not the live ones, so
  // a thread that gets a message does not move under the pointer.
  const orderedResults = useMemo(
    () => orderThreadSearchResults(results ?? [], sort),
    [results, sort],
  );
  const searchedQuery = response?.query;
  const highlightQuery = useMemo(
    () => (searchedQuery === undefined ? "" : parseThreadSearchQuery(searchedQuery).query),
    [searchedQuery],
  );
  const searchedInstances = response?.remoteInstances;
  const remoteInstances = useMemo(
    () => (searchedInstances?.length ? describeRemoteInstances(searchedInstances) : undefined),
    [searchedInstances],
  );
  const bodyRef = useRef<HTMLDivElement>(null);
  // ↓ from the search field enters the results; ↑ / ↓ walk them and ↑ from
  // the first returns to the field. The project suggestions take the arrows
  // first while they are open.
  const moveBetweenResults = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const body = bodyRef.current;
    const target = event.target;
    if (!body || !(target instanceof HTMLElement)) return;
    const cards = Array.from(body.querySelectorAll<HTMLElement>(".thread-search-result"));
    const input = body.querySelector<HTMLElement>(".thread-search__field input");
    const index = cards.indexOf(target);
    const down = event.key === "ArrowDown";
    const next = target === input
      ? (down ? cards[0] : undefined)
      : index < 0
        ? undefined
        : index === 0 && !down
          ? input
          : cards[index + (down ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  const runSearch = async (): Promise<void> => {
    const trimmed = store.getSnapshot().query.trim();
    if (!trimmed || !props.desktopApi?.searchThreads) {
      store.settleSearchRequest();
      return;
    }
    const generation = ++searchGeneration.current;
    searching.current = true;
    setLoading(true);
    setCancelled(false);
    setResponse(undefined);
    setError(undefined);
    const parsed = parseThreadSearchQuery(trimmed);
    const scopedThreads = props.threads?.filter((thread) => matchesThreadSearchProjects(thread, parsed.projects));
    const accept = (result: ThreadSearchResponse): void => {
      if (searchGeneration.current !== generation) return;
      store.settleSearchRequest();
      setResponse(mergeAgentMatches(mergePrNumberMatches(result, parsed.query, scopedThreads), parsed.query, scopedThreads));
    };
    try {
      accept(await props.desktopApi.searchThreads({
        contentMode: "available",
        filters: { includeArchived: false },
        limit: 25,
        query: trimmed,
      }, accept));
    } catch (searchError) {
      if (searchGeneration.current === generation) {
        store.settleSearchRequest();
        setError(searchError instanceof Error ? searchError.message : String(searchError));
      }
    } finally {
      if (searchGeneration.current === generation) {
        searching.current = false;
        setLoading(false);
      }
    }
  };

  // A search asked for from outside (⌘K's "search all") runs here, when the
  // panel mounts or while it is open. The request settles when a response or
  // an error arrives, not when the search starts: StrictMode's mount, unmount,
  // mount cancels the first run, and the second mount must run it again.
  const searchRequest = useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().searchRequest,
  );
  const runSearchRef = useRef(runSearch);
  runSearchRef.current = runSearch;
  useEffect(() => {
    if (searchRequest) void runSearchRef.current();
  }, [searchRequest]);

  const cancel = (): void => {
    store.settleSearchRequest();
    searchGeneration.current += 1;
    searching.current = false;
    setLoading(false);
    setCancelled(true);
    if (response) setResponse(stoppedResponse(response));
    void api?.cancelThreadSearch?.().catch(() => undefined);
  };

  const resultCount = response?.results.length ?? 0;

  return (
    <section
      className="thread-view thread-search"
      aria-label="Thread search"
      // Escape closes the search screen from anywhere inside it (the input is
      // autofocused, so this catches the common "⌘⇧F then Esc" path, and still
      // fires after typing). Scoped to the panel rather than a window listener
      // so it won't also dismiss an overlay (e.g. the sidebar quick-search).
      onKeyDown={(event) => {
        // An IME takes the arrows to walk its candidates while composing.
        if (event.defaultPrevented || event.nativeEvent.isComposing) return;
        if (event.key === "Escape" && props.onClose) {
          event.preventDefault();
          props.onClose();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          moveBetweenResults(event);
        }
      }}
    >
      <ThreadPlaceholderHeader
        desktopApi={props.desktopApi}
        title="Search"
        onOpenMessagingActivity={props.onOpenMessagingActivity}
        onOpenMessagingSettings={props.onOpenMessagingSettings}
        layout={
          props.layout ? { ...props.layout, railToggleDisabled: true } : undefined
        }
        masthead={props.masthead}
        history={props.history}
      />

      <div className="thread-search__body" ref={bodyRef}>
        <ThreadSearchForm
          state={store}
          desktopApi={props.desktopApi}
          loading={loading}
          searchUnavailable={searchUnavailable}
          helpOpen={helpOpen}
          helpId={helpId}
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch();
          }}
          onCancel={cancel}
          onToggleHelp={() => setHelpOpen((open) => !open)}
        />

        {helpOpen ? (
          <div id={helpId} className="thread-search__help" role="region" aria-label="Search syntax">
            <strong>Search tips</strong>
            <p>Type <code>@</code> or <code>in:@</code> to choose a project. Use ↑ / ↓ to browse and Enter or Tab to select. Add another mention to search multiple projects.</p>
            <p>Search titles, message content, branches, PR numbers (like #779), or Agent names. Use <code>"ad hoc"</code> to search a phrase.</p>
            <p><code>build @disk</code> or <code>build in:@disk</code> searches projects whose names start with “disk”. Names are case-insensitive.</p>
            <p><code>build @PwrAgent @PwrSnap</code> searches either project. Use <code>@"My Project"</code> for spaces, or a full path to distinguish checkouts.</p>
            <p>A project mention alone lists its recent threads. Quote a literal mention, like <code>"@disk"</code>, to search its text.</p>
          </div>
        ) : null}

        {error ? <p className="thread-search__error">{error}</p> : null}

        {response?.unavailableScopes.length ? (
          <div className="thread-search__scopes" aria-label="Unavailable scopes">
            {response.unavailableScopes.map((scope, index) => (
              <span key={`${scope.scope}:${scope.backend ?? "all"}:${index}`}>
                {scope.backend ? `${scope.backend} ` : ""}
                {scope.scope.replace("_", " ")}: {scope.message}
              </span>
            ))}
          </div>
        ) : null}

        {response ? (
          <div className="thread-search-results-meta">
            <span className="thread-search-results-meta__count" role="status">
              <strong>{resultCount}</strong> {resultCount === 1 ? "thread" : "threads"}
              {response.truncated ? " · Showing the top matches" : ""}
            </span>
            {remoteInstances ? (
              <span
                className="thread-search-results-meta__remote tooltip-target"
                data-tooltip={remoteInstances.detail}
              >
                {remoteInstances.summary}
              </span>
            ) : null}
            {resultCount > 1 ? (
              <div aria-label="Sort results" className="thread-search-sort" role="group">
                <button
                  aria-pressed={sort === "relevance"}
                  className="thread-search-sort__option"
                  type="button"
                  onClick={() => setSort("relevance")}
                >
                  Best match
                </button>
                <button
                  aria-pressed={sort === "latest"}
                  className="thread-search-sort__option"
                  type="button"
                  onClick={() => setSort("latest")}
                >
                  Latest
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {cancelled ? (
          <p className="thread-search__status" role="status">
            Search stopped. Results received so far are shown.
          </p>
        ) : null}
        {loading && resultCount === 0 ? (
          <ThreadSearchEmptyState
            title="Searching threads…"
            hint="Looking across titles, summaries, branches, and message content."
          />
        ) : response ? (
          resultCount > 0 ? (
            <div className="thread-search-results" role="list">
              {orderedResults.map((result) => (
                <ThreadSearchResultItem
                  key={result.identityKey}
                  result={result}
                  isAgent={liveThreads.get(result.identityKey)?.isAgent === true}
                  timestamp={
                    liveThreads.get(result.identityKey)?.updatedAt ?? resultTimestamp(result)
                  }
                  query={highlightQuery}
                  onOpen={openResult}
                  onOpenRemoteViewer={showsRemoteViewer ? openRemoteViewer : undefined}
                />
              ))}
            </div>
          ) : (
            <ThreadSearchEmptyState
              title={cancelled ? "Search stopped" : "No threads match that search"}
              hint={cancelled ? "Run the search again to check all connected instances."
                : `Nothing came back for “${response.query}”. Try a broader term or different wording.`}
            />
          )
        ) : (
          <ThreadSearchEmptyState
            title={searchUnavailable ? "Search is unavailable" : "Search your threads"}
            hint={
              searchUnavailable
                ? "Thread search isn’t available in this session yet."
                : "Find any thread by its title, summary, linked branch, or message content across every backend."
            }
          />
        )}
      </div>
    </section>
  );
}
