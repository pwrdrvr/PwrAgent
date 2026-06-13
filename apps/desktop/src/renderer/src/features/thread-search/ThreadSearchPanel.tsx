import {
  useMemo,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import type {
  AppServerBackendKind,
  MessagingChannelKind,
  ThreadSearchConfidenceBand,
  ThreadSearchMatchReasonKind,
  ThreadSearchResponse,
  ThreadSearchResult,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import type { HistoryNavControls } from "../chrome/HistoryNavButtons";
import type { MastheadActionsProps } from "../chrome/MastheadActions";
import { ThreadPlaceholderHeader } from "../thread-detail/ThreadPlaceholderHeader";
import { BranchIcon, FolderIcon, SearchIcon, WorktreeIcon } from "../../icons";

/**
 * The query + results pair, liftable above the panel. The panel unmounts
 * whenever the operator opens a result (mainView flips to "thread"), so
 * App owns an instance of this state — that's what lets history Back land
 * on a still-populated results list instead of a blank search form.
 */
export type ThreadSearchPanelState = {
  query: string;
  setQuery: (query: string) => void;
  response: ThreadSearchResponse | undefined;
  setResponse: (response: ThreadSearchResponse | undefined) => void;
};

export function useThreadSearchPanelState(): ThreadSearchPanelState {
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<ThreadSearchResponse>();
  return useMemo(
    () => ({ query, setQuery, response, setResponse }),
    [query, response],
  );
}

type ThreadSearchPanelProps = {
  desktopApi?: DesktopApi;
  onOpenResult: (result: {
    backend: AppServerBackendKind;
    threadId: string;
  }) => Promise<void> | void;
  onOpenMessagingActivity?: (platform?: MessagingChannelKind) => void;
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
  backend_match: "Backend match",
  model_match: "Model match",
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
      query
        .toLowerCase()
        .split(/\s+/)
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

function ThreadSearchResultRow(props: {
  result: ThreadSearchResult;
  query: string;
  onOpen: () => void;
}): ReactElement {
  const { result, query } = props;
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
    <button className="thread-search-result" type="button" onClick={props.onOpen}>
      <span className="thread-search-result__body">
        <span className="thread-search-result__title">{result.title}</span>
        <span className="thread-search-result__meta">
          <span className="chip chip--backend">{result.backend}</span>
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
        <span
          className={`thread-search-result__confidence thread-search-result__confidence--${result.confidence}`}
        >
          <span className="thread-search-result__confidence-dot" aria-hidden />
          {result.confidence}
        </span>
        <span className="thread-search-result__reason">
          {describeMatchReason(result.matchReasons[0]?.kind)}
        </span>
      </span>
    </button>
  );
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

export function ThreadSearchPanel(props: ThreadSearchPanelProps) {
  const localState = useThreadSearchPanelState();
  const { query, setQuery, response, setResponse } = props.state ?? localState;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const searchUnavailable = !props.desktopApi?.searchThreads;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed || !props.desktopApi?.searchThreads) {
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      setResponse(
        await props.desktopApi.searchThreads({
          contentMode: "available",
          limit: 25,
          query: trimmed,
        }),
      );
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : String(searchError));
    } finally {
      setLoading(false);
    }
  };

  const resultCount = response?.results.length ?? 0;

  return (
    <section className="thread-view thread-search" aria-label="Thread search">
      <ThreadPlaceholderHeader
        desktopApi={props.desktopApi}
        title="Search"
        onOpenMessagingActivity={props.onOpenMessagingActivity}
        layout={
          props.layout ? { ...props.layout, railToggleDisabled: true } : undefined
        }
        masthead={props.masthead}
        history={props.history}
      />

      <div className="thread-search__body">
        <form className="thread-search__form" onSubmit={(event) => void submit(event)}>
          <div className="thread-search__field">
            <span className="thread-search__field-icon" aria-hidden>
              <SearchIcon size={16} />
            </span>
            <input
              autoFocus
              aria-label="Search threads"
              value={query}
              placeholder="Search by title, message content, or branch"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <button
            className="button button--primary thread-search__submit"
            disabled={loading || !query.trim() || searchUnavailable}
            type="submit"
          >
            <SearchIcon size={15} aria-hidden />
            <span>{loading ? "Searching" : "Search"}</span>
          </button>
        </form>

        {error ? <p className="thread-search__error">{error}</p> : null}

        {response?.unavailableScopes.length ? (
          <div className="thread-search__scopes" aria-label="Unavailable scopes">
            {response.unavailableScopes.map((scope, index) => (
              <span key={`${scope.scope}:${scope.backend ?? "all"}:${index}`}>
                {scope.backend ? `${scope.backend} ` : ""}
                {scope.scope.replace("_", " ")}: {scope.reason}
              </span>
            ))}
          </div>
        ) : null}

        {response && resultCount > 0 ? (
          <p className="thread-search-results-meta">
            <span>
              <strong>{resultCount}</strong> {resultCount === 1 ? "thread" : "threads"}
            </span>
            {response.truncated ? <span>Showing the top matches</span> : null}
          </p>
        ) : null}

        {loading && !response ? (
          <ThreadSearchEmptyState
            title="Searching threads…"
            hint="Looking across titles, summaries, branches, and message content."
          />
        ) : response ? (
          resultCount > 0 ? (
            <div className="thread-search-results" role="list">
              {response.results.map((result) => (
                <div key={result.identityKey} role="listitem">
                  <ThreadSearchResultRow
                    result={result}
                    query={response.query}
                    onOpen={() => {
                      void props.onOpenResult({
                        backend: result.backend,
                        threadId: result.threadId,
                      });
                    }}
                  />
                </div>
              ))}
            </div>
          ) : (
            <ThreadSearchEmptyState
              title="No threads match that search"
              hint={`Nothing came back for “${response.query}”. Try a broader term or different wording.`}
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
