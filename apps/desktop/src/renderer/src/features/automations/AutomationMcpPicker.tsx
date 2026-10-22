import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  CodexMcpServerSummary,
  McpConnectionStatus,
} from "@pwragent/shared";
import { formatMcpConnectionState } from "../thread-detail/McpAccessPanel";

/**
 * Chip + suggestion control for the run's MCP-server allowlist.
 *
 * Suggestions come from two places: the MCP Gateway's connections (Datadog,
 * say), which PwrAgent hands to a run itself, and the selected Agent thread's
 * live Codex inventory. Either way the operator picks from servers that
 * actually exist instead of guessing names into a comma-separated box.
 * Free-text entry stays available (Enter or comma) because a server can be
 * configured but currently disconnected — an allowlist naming it should
 * still be expressible.
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
  /**
   * Load the MCP Gateway's connections. They belong to the profile, not the
   * Agent, so they are listed even before an Agent is chosen. A picked
   * connection is stored by id, so renaming it keeps the automation working.
   */
  loadGatewayConnections?: () => Promise<McpConnectionStatus[]>;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [servers, setServers] = useState<CodexMcpServerSummary[]>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [gateway, setGateway] = useState<McpConnectionStatus[]>([]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();

  const { loadGatewayConnections, loadServers, onChange, selected } = props;

  // Loaded at mount, unlike the Agent inventory: a saved chip stores the
  // connection id and needs the list to show the display name.
  useEffect(() => {
    if (!loadGatewayConnections) return;
    let cancelled = false;
    loadGatewayConnections()
      .then((result) => {
        if (!cancelled) setGateway(result);
      })
      .catch(() => {
        if (!cancelled) setGateway([]);
      });
    return () => {
      cancelled = true;
    };
  }, [loadGatewayConnections]);

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
  // Only offered connections are suggested, but every one names its chip:
  // a connection switched off since it was picked still reads as itself.
  const gatewaySuggestions = gateway.filter(
    (connection) =>
      connection.enabled
      && !selected.includes(connection.id)
      && (normalized.length === 0
        || connection.displayName.toLowerCase().includes(normalized)
        || connection.id.toLowerCase().includes(normalized)),
  );
  const suggestions = (servers ?? []).filter(
    (server) =>
      !selected.includes(server.name)
      && (normalized.length === 0
        || server.name.toLowerCase().includes(normalized)),
  );
  // A typed gateway display name is stored by id, as a picked one is, unless
  // an Agent server answers to the same name.
  const typedEntry = (text: string): string => {
    const name = text.trim().toLowerCase();
    if ((servers ?? []).some((server) => server.name.toLowerCase() === name)) {
      return text;
    }
    return gateway.find(
      (connection) =>
        connection.enabled && connection.displayName.toLowerCase() === name,
    )?.id ?? text;
  };
  const chipLabel = (name: string): string =>
    gateway.find((connection) => connection.id === name)?.displayName ?? name;

  return (
    <div className="automation-sender-picker" ref={containerRef}>
      {selected.length > 0 ? (
        <ul className="automation-sender-picker__chips">
          {selected.map((name) => (
            <li className="chip automation-sender-chip" key={name}>
              <span className="automation-sender-chip__label">
                {chipLabel(name)}
              </span>
              <button
                type="button"
                className="automation-sender-chip__remove"
                aria-label={`Remove ${chipLabel(name)}`}
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
            add(typedEntry(query));
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      />

      {open ? (
        <div className="automation-sender-picker__menu" id={listId}>
          {gatewaySuggestions.length > 0 ? (
            <div>
              <p className="automation-sender-picker__section">
                PwrAgent gateway
              </p>
              {gatewaySuggestions.map((connection) => (
                <button
                  type="button"
                  className="automation-sender-picker__option"
                  key={connection.id}
                  onClick={() => add(connection.id)}
                >
                  <span className="automation-sender-picker__name">
                    {connection.displayName}
                  </span>
                  <span className="automation-sender-picker__id">
                    <GatewayState connection={connection} />
                  </span>
                </button>
              ))}
            </div>
          ) : undefined}
          {!loadServers ? (
            <p className="automation-sender-picker__empty">
              Choose an Agent in Deliver below to list its MCP servers. You can
              still type a server name and press Enter.
            </p>
          ) : servers === undefined ? (
            <p className="automation-sender-picker__empty">Loading servers…</p>
          ) : suggestions.length === 0 ? (
            gatewaySuggestions.length > 0 && !loadFailed ? undefined : (
              <p className="automation-sender-picker__empty">
                {loadFailed
                  ? "Couldn't read the Agent's MCP servers. Type a server name and press Enter."
                  : servers.length === 0
                    ? "The Agent has no MCP servers configured. Type a name to allow one anyway."
                    : "No matching servers. Press Enter to add what you typed."}
              </p>
            )
          ) : (
            <div>
              <p className="automation-sender-picker__section">
                Agent&rsquo;s Codex servers
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

/** The thread MCP access panel's words, so the state reads the same in both. */
function GatewayState(props: { connection: McpConnectionStatus }) {
  const label = formatMcpConnectionState(props.connection);
  return label === "Ready" ? (
    <>{label}</>
  ) : (
    <span className="automation-sender-picker__badge">{label}</span>
  );
}
