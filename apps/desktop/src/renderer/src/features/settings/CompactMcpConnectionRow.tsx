import type { ReactNode } from "react";

/**
 * A built-in connection nobody has set up: one line with its name, what it
 * is, and the actions that start setup. Sandboxer and GitHub share it so the
 * two read as the same kind of row.
 */
export function CompactMcpConnectionRow(props: {
  name: string;
  meta: ReactNode;
  children: ReactNode;
}) {
  return (
    <article className="settings-mcp-row settings-mcp-row--managed settings-mcp-row--compact">
      <div className="settings-mcp-row__main">
        <span className="settings-mcp-row__toggle settings-mcp-row__toggle--static">
          <span className="settings-mcp-row__name">{props.name}</span>
          <span className="settings-mcp-row__meta">{props.meta}</span>
        </span>
        <div className="settings-mcp-row__actions">{props.children}</div>
      </div>
    </article>
  );
}
