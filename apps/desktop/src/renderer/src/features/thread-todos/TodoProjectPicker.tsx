import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ThreadTodo, ThreadTodoProject } from "@pwragent/shared";
import { ChevronDownIcon, FolderIcon, SearchIcon } from "../../icons";
import { tildifyPath } from "../../lib/tildify-path";
import { useDismissableLayer } from "../../lib/useDismissableLayer";
import type { ThreadTodoProjectMenu } from "./thread-todos-view";

export type TodoProjectPickerProps = {
  todo: ThreadTodo;
  /** Absent where the card's project cannot change: the line is static. */
  menu?: ThreadTodoProjectMenu;
  /** A running action's project is fixed until it ends. */
  disabled?: boolean;
};

type Row = {
  key: string;
  label: string;
  path?: string;
  /** Picking it clears the tag rather than naming a project. */
  clears: boolean;
  thisThread: boolean;
};

/**
 * The project line under a card's title: where the card's action runs. The
 * thread's own project reads muted, another project in the accent as
 * "For PwrSnap", and the chevron opens the composer project picker's
 * popover to change it. Picking the thread's own project clears the tag.
 */
export function TodoProjectPicker(props: TodoProjectPickerProps) {
  const { todo, menu } = props;
  const source = todo.sourceProject;
  const target = todo.targetProject;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [projects, setProjects] = useState<ThreadTodoProject[]>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const close = (): void => {
    setOpen(false);
    setQuery("");
    setError(undefined);
  };

  useDismissableLayer({ open, onDismiss: close, surfaceRef: containerRef, triggerRef });

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [open]);

  // Fetched on each open, so a project added since the last one is there.
  useEffect(() => {
    if (!open || !menu) return;
    let cancelled = false;
    menu.list().then((listed) => {
      if (!cancelled) setProjects(listed);
    }).catch((listError: unknown) => {
      if (!cancelled) setError(errorText(listError, "Projects could not be listed."));
    });
    return () => {
      cancelled = true;
    };
  }, [open, menu]);

  const currentKey = target?.key ?? source?.key;
  const rows = useMemo(() => {
    const own: Row[] = source
      ? [{ key: source.key, label: source.label, path: source.path, clears: true, thisThread: true }]
      : target
        ? [{ key: "", label: "No project", clears: true, thisThread: true }]
        : [];
    const others: Row[] = (projects ?? [])
      .filter((project) => project.key !== source?.key)
      .map((project) => ({
        key: project.key,
        label: project.label,
        path: project.path,
        clears: false,
        thisThread: false,
      }));
    const needle = query.trim().toLowerCase();
    const matches = (row: Row): boolean =>
      !needle
      || row.label.toLowerCase().includes(needle)
      || (row.path ?? "").toLowerCase().includes(needle);
    return { own: own.filter(matches), others: others.filter(matches) };
  }, [projects, query, source, target]);

  const label = target ? `For ${target.label}` : source?.label ?? "No project";
  const tone = target ? " is-target" : source ? "" : " is-empty";

  if (!menu) {
    if (!target) return null;
    return (
      <p className={`thread-todo-card__project${tone}`}>
        <FolderIcon size={11} aria-hidden="true" />
        <span className="thread-todo-card__project-label">{label}</span>
      </p>
    );
  }

  const pick = (row: Row): void => {
    const projectKey = row.clears ? null : row.key;
    if ((projectKey ?? source?.key) === currentKey) {
      close();
      return;
    }
    setSaving(true);
    setError(undefined);
    menu.set(todo, projectKey).then(() => {
      close();
    }).catch((cause: unknown) => {
      setError(errorText(cause, "The project could not be changed."));
    }).finally(() => {
      setSaving(false);
    });
  };

  const renderRow = (row: Row) => {
    const active = row.clears ? !target : row.key === currentKey;
    return (
      <li key={row.key || "none"}>
        <button
          type="button"
          role="option"
          aria-selected={active}
          disabled={saving}
          className={`project-picker__row${active ? " is-active" : ""}`}
          onClick={() => pick(row)}
        >
          <span aria-hidden="true" className="project-picker__row-check">
            {active ? "✓" : ""}
          </span>
          <span aria-hidden="true" className="project-picker__row-icon">
            <FolderIcon size={13} />
          </span>
          <span className="project-picker__row-name">{row.label}</span>
          {row.thisThread && row.path ? (
            <span className="thread-todo-project__tag">This thread</span>
          ) : null}
          <span className="project-picker__row-path">
            {row.path ? tildifyPath(row.path) : ""}
          </span>
        </button>
      </li>
    );
  };

  return (
    <span
      ref={containerRef}
      className="thread-todo-project"
      data-state={open ? "open" : "closed"}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`thread-todo-card__project thread-todo-card__project--button${tone}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={`Project: ${label}. Change project`}
        title="Change project"
        disabled={props.disabled}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <FolderIcon size={11} aria-hidden="true" />
        <span className="thread-todo-card__project-label">{label}</span>
        <ChevronDownIcon size={11} aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="project-picker__pop thread-todo-project__pop"
          role="dialog"
          aria-label="Project for this to-do"
        >
          <div className="project-picker__search">
            <span aria-hidden="true" className="project-picker__search-icon">
              <SearchIcon size={13} />
            </span>
            <input
              type="text"
              autoFocus
              placeholder="Find a project"
              aria-label="Find a project"
              className="project-picker__search-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="project-picker__section">Projects</div>
          <ul
            id={listboxId}
            className="project-picker__list"
            role="listbox"
            aria-label="Projects"
          >
            {rows.own.map(renderRow)}
            {rows.own.length > 0 && rows.others.length > 0 ? (
              <li aria-hidden="true" className="project-picker__separator" />
            ) : null}
            {rows.others.map(renderRow)}
            {projects && rows.own.length === 0 && rows.others.length === 0 ? (
              <li className="project-picker__empty">
                {query ? "No matches." : "No projects yet."}
              </li>
            ) : null}
          </ul>
          {error ? (
            <p role="alert" className="project-picker__error">{error}</p>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}

function errorText(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  // Electron prefixes a rejected invoke with the channel; the reason follows.
  const reason = message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "");
  return reason || fallback;
}
