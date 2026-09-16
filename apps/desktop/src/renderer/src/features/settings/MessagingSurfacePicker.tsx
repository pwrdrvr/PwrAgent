import { useEffect, useId, useRef, useState } from "react";
import type { MessagingConversationKind } from "@pwragent/shared";
import { SearchIcon } from "../../icons";

type SurfaceOption = {
  value: string;
  label: string;
  detail?: string;
  kind?: MessagingConversationKind;
};

type SurfaceFilter = "roots" | "channel" | "dm" | "topic";
const FILTERS: { value: SurfaceFilter; label: string }[] = [
  { value: "roots", label: "Channels & DMs" },
  { value: "channel", label: "Channels / groups" },
  { value: "dm", label: "Direct messages" },
  { value: "topic", label: "Telegram topics" },
];

export function MessagingSurfacePicker(props: {
  value: string;
  options: SurfaceOption[];
  filterConversations: boolean;
  allowTopics?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SurfaceFilter>("roots");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const selected = props.options.find((option) => option.value === props.value);
  const visible = props.options.filter((option) => {
    if (props.filterConversations && option.kind) {
      if (option.kind === "thread" || (option.kind === "topic" && !props.allowTopics)) return false;
      if (filter === "roots" && option.kind !== "channel" && option.kind !== "dm") return false;
      if (filter === "topic" && option.kind !== "topic") return false;
      if ((filter === "channel" || filter === "dm") && option.kind !== filter) return false;
    }
    return `${option.label} ${option.detail ?? ""}`.toLowerCase().includes(query.trim().toLowerCase());
  });
  const activeIndex = Math.min(active, Math.max(0, visible.length - 1));
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const choose = (value: string) => {
    props.onChange(value);
    close();
  };

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex, listId]);

  return (
    <div ref={root} className="messaging-surface-picker"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <button ref={trigger} type="button" className="settings-select messaging-surface-picker__trigger"
        aria-label="Messaging surface" aria-haspopup="dialog" aria-expanded={open}
        onClick={() => {
          setQuery("");
          setActive(0);
          setFilter(selected?.kind === "topic" ? "topic" : "roots");
          setOpen(!open);
        }}
      >
        {selected?.label ?? (props.value === "manual" ? "Enter an ID manually..." : "Choose a recently seen surface...")}
      </button>
      {open ? (
        <div className="messaging-surface-picker__panel" role="dialog" aria-label="Choose a messaging surface">
          <div className="project-picker__search">
            <SearchIcon size={14} />
            <input autoFocus className="project-picker__search-input" role="combobox"
              aria-label="Find a messaging surface" placeholder="Find a channel, DM, or ID"
              aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
              aria-activedescendant={visible.length ? `${listId}-${activeIndex}` : undefined}
              value={query} onChange={(event) => { setQuery(event.target.value); setActive(0); }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setActive(Math.max(0, Math.min(visible.length - 1, activeIndex + (event.key === "ArrowDown" ? 1 : -1))));
                } else if (event.key === "Enter" && visible[activeIndex]) {
                  event.preventDefault();
                  choose(visible[activeIndex].value);
                }
              }}
            />
          </div>
          {props.filterConversations ? (
            <div className="messaging-surface-picker__filters" role="group" aria-label="Conversation types">
              {FILTERS.filter((item) => item.value !== "topic" || props.allowTopics).map((item) => (
                <button type="button" className="button button--ghost" key={item.value}
                  aria-pressed={filter === item.value}
                  onClick={() => { setFilter(item.value); setActive(0); }}
                >{item.label}</button>
              ))}
            </div>
          ) : null}
          <div id={listId} role="listbox" aria-label="Messaging surfaces" className="messaging-surface-picker__list">
            {visible.map((option, index) => (
              <button type="button" role="option" id={`${listId}-${index}`} key={option.value}
                aria-selected={props.value === option.value}
                className={`project-picker__row${index === activeIndex ? " is-active" : ""}`}
                onClick={() => choose(option.value)}
              >
                <span className="project-picker__row-check">{props.value === option.value ? "✓" : ""}</span>
                <span className="messaging-surface-picker__identity">
                  <span>{option.label}</span>
                  {option.detail ? <small>{option.detail}</small> : null}
                </span>
              </button>
            ))}
          </div>
          {visible.length === 0 ? <p className="messaging-routes__empty">No matching surfaces.</p> : null}
          <button type="button" className="project-picker__row" onClick={() => choose("manual")}>
            Enter an ID manually...
          </button>
        </div>
      ) : null}
    </div>
  );
}
