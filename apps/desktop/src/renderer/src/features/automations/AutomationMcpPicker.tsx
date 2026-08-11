import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CodexMcpServerSummary } from "@pwragent/shared";

/**
 * Chip + suggestion control for the run's MCP-server allowlist.
 *
 * Suggestions come from the selected Agent thread's live MCP inventory, so the
 * operator picks from servers that actually exist instead of guessing names
 * into a comma-separated box. Free-text entry stays available (Enter or comma)
 * because a server can be configured but currently disconnected — an allowlist
 * naming it should still be expressible.
 */
export function AutomationMcpPicker(props: {
  selected: string[];
  onChange: (selected: string[]) => void;
  /**
   * Load the Agent thread's MCP inventory. Undefined when no Agent is chosen
   * yet — the picker then degrades to free-text entry with a hint instead of
   * an empty suggestion list that looks like "no servers exist".
   */
  loadServers?: () => Promise<CodexMcpServerSummary[]>;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [servers, setServers] = useState<CodexMcpServerSummary[]>();
  const [loadFailed, setLoadFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();

  const { loadServers, onChange, selected } = props;

  // The inventory is fetched once per Agent selection, on first open — not per
  // keystroke, and not at mount for a disclosure the operator may never expand.
  useEffect(() => {
    if (!open || servers !== undefined || !loadServers) return;
    let cancelled = false;
    loadServers()
      .then((result) => {
        if (!cancelled) setServers(result);
      })
      .catch(() => {
        if (!cancelled) {
          setServers([]);
          setLoadFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, servers, loadServers]);

  // A different Agent has a different inventory.
  useEffect(() => {
    setServers(undefined);
    setLoadFailed(false);
  }, [loadServers]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const add = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (!trimmed || selected.includes(trimmed)) return;
      onChange([...selected, trimmed]);
      setQuery("");
    },
    [onChange, selected],
  );

  const remove = useCallback(
    (name: string) => {
      onChange(selected.filter((entry) => entry !== name));
    },
    [onChange, selected],
  );

  const normalized = query.trim().toLowerCase();
  const suggestions = (servers ?? []).filter(
    (server) =>
      !selected.includes(server.name)
      && (normalized.length === 0
        || server.name.toLowerCase().includes(normalized)),
  );

  return (
    <div className="automation-sender-picker" ref={containerRef}>
      {selected.length > 0 ? (
        <ul className="automation-sender-picker__chips">
          {selected.map((name) => (
            <li className="chip automation-sender-chip" key={name}>
              <span className="automation-sender-chip__label">{name}</span>
              <button
                type="button"
                className="automation-sender-chip__remove"
                aria-label={`Remove ${name}`}
                onClick={() => remove(name)}
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
        placeholder="Add an MCP server…"
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label="Allowed MCP servers"
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            add(query);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      />

      {open ? (
        <div className="automation-sender-picker__menu" id={listId}>
          {!loadServers ? (
            <p className="automation-sender-picker__empty">
              Choose an Agent in Deliver below to list its MCP servers. You can
              still type a server name and press Enter.
            </p>
          ) : servers === undefined ? (
            <p className="automation-sender-picker__empty">Loading servers…</p>
          ) : suggestions.length === 0 ? (
            <p className="automation-sender-picker__empty">
              {loadFailed
                ? "Couldn't read the Agent's MCP servers. Type a server name and press Enter."
                : servers.length === 0
                  ? "The Agent has no MCP servers configured. Type a name to allow one anyway."
                  : "No matching servers. Press Enter to add what you typed."}
            </p>
          ) : (
            <div>
              <p className="automation-sender-picker__section">
                Agent&rsquo;s MCP servers
              </p>
              {suggestions.map((server) => (
                <button
                  type="button"
                  className="automation-sender-picker__option"
                  key={server.name}
                  onClick={() => add(server.name)}
                >
                  <span className="automation-sender-picker__name">
                    {server.name}
                  </span>
                  <span className="automation-sender-picker__id">
                    {server.tools.length}{" "}
                    {server.tools.length === 1 ? "tool" : "tools"}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : undefined}
    </div>
  );
}
