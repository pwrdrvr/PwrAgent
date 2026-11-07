import { useCallback, useRef, useState } from "react";
import type { NavigationThreadSummary, ThreadTodo, ThreadTodoMessageTarget } from "@pwragent/shared";
import { formatBackendLabel } from "../../lib/backend-label";
import { useThreadLinks, type ResolvedThreadLink } from "../../lib/thread-links";
import { ThreadChip } from "../thread-detail/ThreadChip";
import { ThreadSearchPicker } from "../thread-search/ThreadSearchPicker";
import { useTodoDispatchContext } from "./TodoDispatchProvider";
import type { ThreadTodoLocalMachine } from "./thread-todos-view";
import { addressableTodoDestinations } from "./todo-destination-addressing";

const NO_THREADS: readonly NavigationThreadSummary[] = [];

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
  // Only Change moves focus into the field. A card that opens without a
  // destination must not take focus from the composer.
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  const changeRef = useRef<HTMLButtonElement>(null);
  const owner = props.todo.federationTarget?.instanceId;
  const target = props.target;
  const threadLinks = useThreadLinks();
  const searchAvailable = Boolean(api?.getNavigationQueryPage);
  const { todo, localMachine } = props;
  const toCandidates = useCallback(
    (threads: readonly NavigationThreadSummary[]) => addressableTodoDestinations(threads, todo, localMachine),
    [todo, localMachine],
  );
  // A target without its own owner lives on the card's machine.
  const targetInstanceId = target?.instanceId ?? owner;
  const resolved = target && threadLinks?.resolve({ backend: target.backend, threadId: target.threadId,
    ...(targetInstanceId ? { instanceId: targetInstanceId } : {}) });
  // The card's recorded label names the machine until navigation knows it.
  const targetLink: ResolvedThreadLink | undefined = resolved && target?.instanceLabel && !resolved.instanceLabel
    && resolved.instanceId ? { ...resolved, instanceLabel: target.instanceLabel } : resolved;
  return (
    <div className="todo-message-destination">
      <div className="todo-message-destination__heading">
        <span>To</span>
        <span className="todo-message-destination__target">
          {target && targetLink && threadLinks ? (
            <ThreadChip fallbackLabel={target.title ?? target.threadId} link={targetLink}
              onOpen={(link) => threadLinks.show(link)} />
          ) : target ? target.title ?? target.threadId : "Choose an existing thread"}
          {target ? (
            <small>
              {formatBackendLabel(target.backend)} · {target.instanceLabel ?? target.instanceId ?? "Card's machine"}
              {threadLinks ? null : <> · {target.threadId}</>}
            </small>
          ) : null}
        </span>
        {target && searchAvailable ? (
          <button ref={changeRef} type="button" className="button thread-todo-card__button" disabled={props.disabled}
            onClick={() => {
              setFocusOnOpen(!editing);
              setEditing(!editing);
            }}>{editing ? "Cancel" : "Change"}</button>
        ) : null}
      </div>
      {editing && !searchAvailable ? <p>Thread search is unavailable in this window.</p> : null}
      {editing && api && searchAvailable ? (
        <ThreadSearchPicker
          toCandidates={toCandidates}
          fieldLabel="Find destination thread"
          listLabel="Destination threads"
          disabled={props.disabled}
          api={api}
          threads={threadLinks?.readLoadedThreads?.() ?? NO_THREADS}
          focusOnOpen={focusOnOpen}
          {...(target ? { onCancel: () => setEditing(false), triggerRef: changeRef } : {})}
          onPick={(next) => {
            props.onSelect(next);
            setEditing(false);
          }}
        />
      ) : null}
    </div>
  );
}
