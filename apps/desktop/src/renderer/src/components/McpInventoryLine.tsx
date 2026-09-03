import { useState } from "react";

/**
 * The expandable "Tools · 28 — a, b, c … Show 20 more" line.
 *
 * Lifted out of `McpInventoryPanel` so the Settings → Plugins → MCPs pane can
 * render the same payload the same way. Both surfaces receive the identical
 * `CodexMcpServerSummary.tools` array; the Settings pane used to reduce it to
 * a count and drop the names on the floor.
 */
export function McpInventoryLine(props: {
  label: string;
  previewLimit: number;
  values: string[];
  /**
   * Extra class, appended to the base line class rather than replacing it —
   * the base carries the shared two-column line grid, and a caller that
   * swapped it out silently lost that layout.
   */
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasOverflow = props.values.length > props.previewLimit;
  const visibleValues = expanded || !hasOverflow
    ? props.values
    : props.values.slice(0, props.previewLimit);
  const hiddenCount = props.values.length - visibleValues.length;

  return (
    <div
      className={
        props.className
          ? `mcp-inventory-panel__line ${props.className}`
          : "mcp-inventory-panel__line"
      }
    >
      <span className="mcp-inventory-panel__line-label">
        {props.label}
        <span className="mcp-inventory-panel__line-count">
          {` · ${props.values.length}`}
        </span>
      </span>
      <div className="mcp-inventory-panel__line-value">
        <span className="mcp-inventory-panel__line-items">
          {visibleValues.length > 0 ? visibleValues.join(", ") : "None"}
        </span>
        {hasOverflow ? (
          <button
            type="button"
            className="mcp-inventory-panel__line-toggle"
            aria-expanded={expanded}
            aria-label={
              expanded
                ? `Show fewer ${props.label}`
                : `Show ${hiddenCount} more ${props.label}`
            }
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "Show less" : `Show ${hiddenCount} more`}
          </button>
        ) : null}
      </div>
    </div>
  );
}
