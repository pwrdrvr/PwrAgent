import { useEffect, useRef, useState } from "react";
import type { ThreadSearchResult, ThreadTodo, ThreadTodoMessageTarget } from "@pwragent/shared";
import { useTodoDispatchContext } from "./TodoDispatchProvider";
import type { ThreadTodoLocalMachine } from "./thread-todos-view";

/** Selecting a destination only prepares the proposal; Send remains a separate click. */
export function TodoMessageDestination(props: {
  todo: ThreadTodo;
  target?: ThreadTodoMessageTarget;
  localMachine?: ThreadTodoLocalMachine;
  disabled: boolean;
  onSelect: (target: ThreadTodoMessageTarget) => void;
}) {
  const { api } = useTodoDispatchContext();
  const [editing, setEditing] = useState(!props.target);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ThreadSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; }, []);
  const owner = props.todo.federationTarget?.instanceId;
  const destination = (result: ThreadSearchResult): ThreadTodoMessageTarget | undefined => {
    const resultIsRemote = result.federation?.ref.target.scope === "remote";
    const instanceId = result.federation?.ref.target.scope === "remote"
      ? result.federation.ref.target.instanceId : props.localMachine?.instanceId;
    // A local result cannot be addressed from a remote card without this window's identity.
    if (owner && !instanceId) return undefined;
    const remote = instanceId !== owner && (owner !== undefined || resultIsRemote);
    if (!remote && result.backend === props.todo.backend && result.threadId === props.todo.threadId) return undefined;
    return {
      backend: result.backend, threadId: result.threadId, title: result.title,
      ...(remote && instanceId ? { instanceId } : {}),
      ...(result.federation?.instanceLabel ? { instanceLabel: result.federation.instanceLabel }
        : props.localMachine?.label ? { instanceLabel: props.localMachine.label } : {}),
    };
  };
  const target = props.target;
  return (
    <div className="todo-message-destination">
      <div className="todo-message-destination__heading">
        <span>To</span>
        <span className="todo-message-destination__target">
          {target ? target.title ?? target.threadId : "Choose an existing thread"}
          {target ? <small>{target.backend} · {target.instanceLabel ?? target.instanceId ?? "Card's machine"} · {target.threadId}</small> : null}
        </span>
        {target && api?.searchThreads ? (
          <button type="button" className="button thread-todo-card__button" disabled={props.disabled}
            onClick={() => setEditing(!editing)}>{editing ? "Cancel" : "Change"}</button>
        ) : null}
      </div>
      {editing ? (
        <>
          <form className="todo-message-destination__search" onSubmit={(event) => {
            event.preventDefault();
            if (!api?.searchThreads || !query.trim() || props.disabled) return;
            const current = ++generation.current;
            setLoading(true);
            setSearched(true);
            setError(undefined);
            setResults([]);
            void api.searchThreads({ query: query.trim(), contentMode: "metadata", filters: { includeArchived: false }, limit: 20 })
              .then((response) => {
                if (current === generation.current) setResults(response.results);
              }).catch((failure: unknown) => {
                if (current === generation.current) setError(failure instanceof Error ? failure.message : String(failure));
              }).finally(() => {
                if (current === generation.current) setLoading(false);
              });
          }}>
            <input aria-label="Find destination thread" placeholder="Search by title, PR, or thread ID"
              value={query} disabled={props.disabled} onChange={(event) => setQuery(event.target.value)} />
            <button type="submit" className="button thread-todo-card__button"
              disabled={props.disabled || loading || !query.trim() || !api?.searchThreads}>Search</button>
          </form>
          {loading ? <p role="status">Searching threads…</p> : null}
          {error ? <p role="alert">{error}</p> : null}
          {!api?.searchThreads ? <p>Thread search is unavailable in this window.</p> : null}
          {searched && !loading && !error && results.length === 0 ? <p>No matching threads found.</p> : null}
          <div className="todo-message-destination__results" aria-label="Destination threads">
            {results.map((result) => {
              const next = destination(result);
              return next ? (
                <button key={result.identityKey} type="button" disabled={props.disabled}
                  onClick={() => { props.onSelect(next); setEditing(false); }}>
                  <span>{result.title}</span>
                  <small>{result.backend} · {result.federation?.instanceLabel ?? props.localMachine?.label ?? "This machine"} · {result.threadId}</small>
                </button>
              ) : null;
            })}
          </div>
          {!loading && results.length > 0 && results.every((result) => !destination(result))
            ? <p>No other addressable threads found.</p> : null}
        </>
      ) : null}
    </div>
  );
}
