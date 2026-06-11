import { useState, type FormEvent } from "react";
import type { AppServerBackendKind, ThreadSearchResponse } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { SearchIcon } from "../../icons";

type ThreadSearchPanelProps = {
  desktopApi?: DesktopApi;
  onClose: () => void;
  onOpenResult: (result: {
    backend: AppServerBackendKind;
    threadId: string;
  }) => Promise<void> | void;
};

export function ThreadSearchPanel(props: ThreadSearchPanelProps) {
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<ThreadSearchResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

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

  return (
    <section className="thread-search-view" aria-label="Thread search">
      <header className="thread-search-view__header">
        <div>
          <p className="thread-search-view__eyebrow">Threads</p>
          <h1>Search</h1>
        </div>
        <button className="button button--ghost" type="button" onClick={props.onClose}>
          Close
        </button>
      </header>

      <form className="thread-search-view__form" onSubmit={(event) => void submit(event)}>
        <label className="thread-search-view__field">
          <span>Query</span>
          <input
            autoFocus
            value={query}
            placeholder="Search threads"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          className="button button--primary thread-search-view__submit"
          disabled={loading || !query.trim() || !props.desktopApi?.searchThreads}
          type="submit"
        >
          <SearchIcon size={15} aria-hidden />
          <span>{loading ? "Searching" : "Search"}</span>
        </button>
      </form>

      {error ? <p className="thread-search-view__error">{error}</p> : null}

      {response?.unavailableScopes.length ? (
        <div className="thread-search-view__scopes" aria-label="Unavailable scopes">
          {response.unavailableScopes.map((scope, index) => (
            <span key={`${scope.scope}:${scope.backend ?? "all"}:${index}`}>
              {scope.backend ? `${scope.backend} ` : ""}
              {scope.scope.replace("_", " ")}: {scope.reason}
            </span>
          ))}
        </div>
      ) : null}

      <div className="thread-search-results" role="list">
        {response?.results.map((result) => (
          <div key={result.identityKey} role="listitem">
            <button
              className="thread-search-result"
              type="button"
              onClick={() => {
                void props.onOpenResult({
                  backend: result.backend,
                  threadId: result.threadId,
                });
              }}
            >
              <span className="thread-search-result__main">
                <span className="thread-search-result__title">{result.title}</span>
                <span className="thread-search-result__meta">
                  {[
                    result.backend,
                    result.projectKey,
                    result.linkedDirectories[0]?.label,
                    result.model,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {result.snippets[0] ? (
                  <span className="thread-search-result__snippet">
                    {result.snippets[0].text}
                  </span>
                ) : null}
              </span>
              <span className="thread-search-result__side">
                <span>{result.confidence}</span>
                <span>{result.matchReasons[0]?.kind.replaceAll("_", " ") ?? "match"}</span>
              </span>
            </button>
          </div>
        ))}
        {response && response.results.length === 0 ? (
          <p className="thread-search-results__empty">No matches</p>
        ) : null}
      </div>
    </section>
  );
}
