import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  MessagingChannelKind,
  MessagingSenderSuggestion,
} from "@pwragent/shared";

const SEARCH_DEBOUNCE_MS = 200;
const MAX_VISIBLE_SUGGESTIONS = 8;

const SOURCE_ORDER: MessagingSenderSuggestion["source"][] = [
  "conversation",
  "automation_runs",
  "directory",
];

export type AutomationSenderPickerProps = {
  /** Selected platform user ids. */
  selected: string[];
  /** Known display names keyed by platform user id, for chip labels. */
  labels: Record<string, string>;
  observedSenders: MessagingSenderSuggestion[];
  provider: MessagingChannelKind | undefined;
  conversationId: string | undefined;
  searchSenders?: (query: string) => Promise<{
    suggestions: MessagingSenderSuggestion[];
    directorySupported: boolean;
    directoryLabel?: string;
    directoryTruncated?: boolean;
  }>;
  onChange: (values: string[], labels: Record<string, string>) => void;
};

/**
 * Chip + autocomplete control for choosing who a filter applies to.
 *
 * The reason this exists instead of a text box: a platform user id is not
 * something an operator can look up without leaving the app. Suggestions are
 * grouped by where they came from, and the group heading is what makes an
 * absent name interpretable — "hasn't posted here" reads very differently from
 * "isn't in this workspace".
 */
export function AutomationSenderPicker(
  props: AutomationSenderPickerProps,
) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [remote, setRemote] = useState<{
    suggestions: MessagingSenderSuggestion[];
    directorySupported: boolean;
    directoryLabel?: string;
    directoryTruncated?: boolean;
  }>({ suggestions: [], directorySupported: false });
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Several sender conditions render several pickers; a hardcoded id would
  // duplicate in the DOM and leave aria-controls pointing at an ambiguous
  // target (which the axe WCAG gate flags as duplicate-id-aria).
  const listId = useId();

  const search = props.searchSenders;
  useEffect(() => {
    if (!open || !search) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void search(query)
        .then((result) => {
          if (!cancelled) setRemote(result);
        })
        .catch(() => {
          // A failed lookup leaves observed senders in place rather than
          // emptying the list the operator is reading.
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query, search]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const grouped = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const matches = (actor: MessagingSenderSuggestion): boolean =>
      normalized.length === 0
      || actor.displayName?.toLowerCase().includes(normalized) === true
      || actor.username?.toLowerCase().includes(normalized) === true
      || actor.platformUserId.toLowerCase() === normalized;

    const seen = new Set(props.selected);
    const byId = new Map<string, MessagingSenderSuggestion>();
    for (const actor of [...props.observedSenders, ...remote.suggestions]) {
      if (seen.has(actor.platformUserId)) continue;
      if (!matches(actor)) continue;
      if (!byId.has(actor.platformUserId)) byId.set(actor.platformUserId, actor);
    }

    const groups = new Map<
      MessagingSenderSuggestion["source"],
      MessagingSenderSuggestion[]
    >();
    for (const actor of byId.values()) {
      const bucket = groups.get(actor.source) ?? [];
      bucket.push(actor);
      groups.set(actor.source, bucket);
    }
    return SOURCE_ORDER.map((source) => ({
      source,
      actors: (groups.get(source) ?? []).slice(0, MAX_VISIBLE_SUGGESTIONS),
    })).filter((entry) => entry.actors.length > 0);
  }, [props.observedSenders, props.selected, query, remote.suggestions]);

  const { onChange, selected } = props;

  const select = useCallback(
    (actor: MessagingSenderSuggestion) => {
      const label = actor.displayName ?? actor.username ?? actor.platformUserId;
      onChange([...selected, actor.platformUserId], {
        [actor.platformUserId]: label,
      });
      setQuery("");
    },
    [onChange, selected],
  );

  const remove = useCallback(
    (platformUserId: string) => {
      onChange(
        selected.filter((value) => value !== platformUserId),
        {},
      );
    },
    [onChange, selected],
  );

  const sourceLabel = (source: MessagingSenderSuggestion["source"]): string => {
    if (source === "conversation") return "Seen in this conversation";
    if (source === "automation_runs") return "From past runs of this automation";
    return remote.directoryLabel ?? "Directory";
  };

  return (
    <div className="automation-sender-picker" ref={containerRef}>
      {props.selected.length > 0 ? (
        <ul className="automation-sender-picker__chips">
          {props.selected.map((platformUserId) => (
            <li className="chip automation-sender-chip" key={platformUserId}>
              <span className="automation-sender-chip__avatar" aria-hidden="true">
                {initials(props.labels[platformUserId] ?? platformUserId)}
              </span>
              <span className="automation-sender-chip__label">
                {props.labels[platformUserId] ?? platformUserId}
              </span>
              <button
                type="button"
                className="automation-sender-chip__remove"
                aria-label={`Remove ${props.labels[platformUserId] ?? platformUserId}`}
                onClick={() => remove(platformUserId)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : undefined}

      <input
        type="text"
        value={query}
        placeholder={
          props.conversationId
            ? "Add a sender — search people, bots, or apps…"
            : "Choose a conversation first"
        }
        disabled={!props.conversationId}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      />

      {open ? (
        <div className="automation-sender-picker__menu" id={listId}>
          {grouped.length === 0 ? (
            <p className="automation-sender-picker__empty">
              {remote.directorySupported
                ? "No matches."
                : "No matches among senders seen here. This provider has no searchable directory, so only people and apps that have already posted can be suggested."}
            </p>
          ) : (
            grouped.map((entry) => (
              <div key={entry.source}>
                <p className="automation-sender-picker__section">
                  {sourceLabel(entry.source)}
                </p>
                {entry.actors.map((actor) => (
                  <button
                    type="button"
                    className="automation-sender-picker__option"
                    key={actor.platformUserId}
                    onClick={() => select(actor)}
                  >
                    <span
                      className="automation-sender-picker__avatar"
                      aria-hidden="true"
                    >
                      {initials(
                        actor.displayName ?? actor.username ?? actor.platformUserId,
                      )}
                    </span>
                    <span className="automation-sender-picker__name">
                      {actor.displayName ?? actor.username ?? actor.platformUserId}
                    </span>
                    {actor.isBot ? (
                      <span className="automation-sender-picker__badge">BOT</span>
                    ) : undefined}
                    <span className="automation-sender-picker__id">
                      {actor.platformUserId}
                    </span>
                  </button>
                ))}
              </div>
            ))
          )}
          {remote.directoryTruncated ? (
            <p className="automation-sender-picker__empty">
              More matches exist — keep typing to narrow the list.
            </p>
          ) : undefined}
        </div>
      ) : undefined}
    </div>
  );
}

function initials(value: string): string {
  const parts = value
    .replace(/^@/, "")
    .split(/[\s._-]+/)
    .filter((part) => part.length > 0);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}
