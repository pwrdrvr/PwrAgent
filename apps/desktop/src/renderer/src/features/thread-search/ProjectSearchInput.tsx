import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { NavigationDirectoryRow } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { FolderIcon, SearchIcon } from "../../icons";
import { tildifyPath } from "../../lib/tildify-path";
import { useDismissableLayer } from "../../lib/useDismissableLayer";

export function projectMentionAtCursor(value: string, cursor: number) {
  const tokens = value.matchAll(/(?:in:)?@"[^"]*(?:"|$)|"[^"]*(?:"|$)|\S+/gi);
  for (const token of tokens) {
    const start = token.index;
    const end = start + token[0].length;
    if (cursor <= start || cursor > end) continue;
    const prefix = /^(?:in:)?@/i.exec(token[0]);
    if (!prefix || cursor < start + prefix[0].length) return undefined;
    return {
      start, end, prefix: prefix[0],
      query: value.slice(start + prefix[0].length, cursor).replace(/^"|"$/g, ""),
    };
  }
  return undefined;
}

/** Replace the mention at the caret with a chosen project; returns the new caret. */
export function insertProjectMention(
  value: string,
  mention: NonNullable<ReturnType<typeof projectMentionAtCursor>>,
  directory: { label: string; path?: string },
): { value: string; cursor: number } {
  const label = directory.label || directory.path!;
  const name = /[\s"@]/.test(label) ? `"${label.replaceAll('"', "")}"` : label;
  const insertion = `${mention.prefix}${name} `;
  return {
    value: value.slice(0, mention.start) + insertion + value.slice(mention.end).replace(/^ /, ""),
    cursor: mention.start + insertion.length,
  };
}

export function ProjectSearchInput(props: {
  value: string;
  onChange: (value: string) => void;
  desktopApi?: DesktopApi;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const pendingCursor = useRef<number | undefined>(undefined);
  const listId = useId();
  const consumerId = useId();
  const [cursor, setCursor] = useState(props.value.length);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [page, setPage] = useState<{
    query: string; directories: NavigationDirectoryRow[]; error?: boolean;
  }>();
  const mention = projectMentionAtCursor(props.value, cursor);
  const open = focused && !dismissed && Boolean(mention);
  const query = open ? mention?.query.trim().toLowerCase() : undefined;
  const settled = query !== undefined && page?.query === query;
  const directories = settled ? page.directories : [];
  const selected = Math.min(active, Math.max(0, directories.length - 1));

  useDismissableLayer({ open, surfaceRef, triggerRef: inputRef, onDismiss: () => setDismissed(true) });

  useEffect(() => {
    if (query === undefined || !props.desktopApi?.getNavigationQueryPage) return;
    let cancelled = false;
    const api = props.desktopApi;
    void api.getNavigationQueryPage!({
      protocol: 2, consumer: "mentions", pageSize: 10,
      query: { kind: "directory-index", filter: query },
    }, consumerId).then((result) => {
      if (!cancelled) setPage({ query, directories: (result.directories ?? [])
        .filter((directory) => directory.kind !== "unlinked" && Boolean(directory.path)) });
    }).catch(() => {
      if (!cancelled) setPage({ query, directories: [], error: true });
    });
    return () => {
      cancelled = true;
      void api.releaseNavigationQuery?.(consumerId);
    };
  }, [consumerId, props.desktopApi, query]);

  useLayoutEffect(() => {
    if (pendingCursor.current === undefined) return;
    inputRef.current?.setSelectionRange(pendingCursor.current, pendingCursor.current);
    pendingCursor.current = undefined;
  }, [props.value]);

  useEffect(() => {
    if (open) document.getElementById(`${listId}-${selected}`)?.scrollIntoView?.({ block: "nearest" });
  }, [listId, open, selected]);

  const choose = (directory: NavigationDirectoryRow) => {
    if (!mention) return;
    const { value, cursor: nextCursor } = insertProjectMention(props.value, mention, directory);
    pendingCursor.current = nextCursor;
    setCursor(nextCursor);
    setDismissed(true);
    props.onChange(value);
    inputRef.current?.focus();
  };

  return (
    <div className="thread-search__field" ref={surfaceRef}>
      <span className="thread-search__field-icon" aria-hidden><SearchIcon size={16} /></span>
      <input
        ref={inputRef}
        autoFocus
        role="combobox"
        aria-label="Search threads"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && directories.length ? `${listId}-${selected}` : undefined}
        value={props.value}
        placeholder="Search threads · @project to narrow"
        onFocus={() => { setFocused(true); setDismissed(false); }}
        onBlur={() => setFocused(false)}
        onSelect={(event) => {
          const nextCursor = event.currentTarget.selectionStart ?? props.value.length;
          if (nextCursor !== cursor) setDismissed(false);
          setCursor(nextCursor);
        }}
        onChange={(event) => {
          setCursor(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
          setDismissed(false);
          setActive(0);
          props.onChange(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (!open) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActive((selected + (event.key === "ArrowDown" ? 1 : -1) + directories.length) % (directories.length || 1));
          } else if ((event.key === "Enter" || event.key === "Tab") && directories.length) {
            event.preventDefault();
            choose(directories[selected]);
          } else if (event.key === "Enter") {
            event.preventDefault();
          }
        }}
      />
      {open ? (
        <div className="composer__autocomplete composer__autocomplete--directories thread-search__projects">
          <div role="listbox" id={listId} aria-label="Projects">
            {directories.map((directory, index) => (
              <button key={directory.key} id={`${listId}-${index}`} type="button" role="option"
                aria-selected={index === selected} tabIndex={-1}
                className={`composer__autocomplete-option${index === selected ? " is-active" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(directory)}>
                <span className="composer__autocomplete-title"><FolderIcon size={13} aria-hidden /><span>{directory.label}</span></span>
                <span className="composer__autocomplete-meta">{tildifyPath(directory.path!)}</span>
              </button>
            ))}
          </div>
          {!directories.length ? <p role="status" className="thread-search__project-status">
            {!props.desktopApi?.getNavigationQueryPage || (settled && page.error) ? "Projects unavailable" : settled ? "No matching projects" : "Loading projects…"}
          </p> : null}
        </div>
      ) : null}
    </div>
  );
}
