import { useEffect, useId, useMemo, useState } from "react";
import type {
  CodexMcpAuthStatus,
  CodexMcpInventoryDetail,
  CodexMcpServerSummary,
  NavigationThreadSummary,
} from "@pwragent/shared";
import { CloseIcon } from "../../icons";
import type { DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { useViewportTooltip } from "../../lib/useViewportTooltip";

export type McpInventoryPanelRequest = {
  detail: CodexMcpInventoryDetail;
  requestId: number;
};

type McpInventoryPanelProps = {
  desktopApi?: DesktopApi;
  onDismiss: () => void;
  request: McpInventoryPanelRequest;
  thread: NavigationThreadSummary;
};

const RELOAD_TOOLTIP =
  "Re-read installed MCP configuration and queue it for loaded Codex threads. "
  + "Each thread receives the updated MCP list when its next turn starts.";
const TOOL_PREVIEW_LIMIT = 8;
const CATALOG_PREVIEW_LIMIT = 3;

export function McpInventoryPanel(props: McpInventoryPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [servers, setServers] = useState<CodexMcpServerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [reloading, setReloading] = useState(false);
  const [reloadStatus, setReloadStatus] = useState<string>();
  const bodyId = useId();
  const reloadTooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const rendererFederationTarget = useMemo(
    () => readRendererFederationTarget(),
    [],
  );
  const federationTarget =
    props.thread.federation?.ref.target ?? rendererFederationTarget;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    setReloadStatus(undefined);
    void props.desktopApi?.listThreadMcpServers?.({
      backend: props.thread.source,
      ...(federationTarget ? { federationTarget } : {}),
      threadId: props.thread.id,
      detail: props.request.detail,
    }).then((response) => {
      if (cancelled) return;
      setServers(response.servers);
      setLoading(false);
    }).catch((nextError: unknown) => {
      if (cancelled) return;
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      setLoading(false);
    });
    if (!props.desktopApi?.listThreadMcpServers) {
      setError("MCP inventory is unavailable in this build.");
      setLoading(false);
    }
    return () => {
      cancelled = true;
    };
  }, [
    federationTarget,
    props.desktopApi,
    props.request.detail,
    props.request.requestId,
    props.thread.id,
    props.thread.source,
  ]);

  const reloadConfig = async (): Promise<void> => {
    if (!props.desktopApi?.reloadCodexMcpConfig || reloading) return;
    setReloading(true);
    setReloadStatus(undefined);
    try {
      await props.desktopApi.reloadCodexMcpConfig({
        backend: props.thread.source,
        ...(federationTarget ? { federationTarget } : {}),
        threadId: props.thread.id,
      });
      setReloadStatus(
        "Config reload queued. The updated MCP list applies when the next turn starts.",
      );
    } catch (nextError) {
      setReloadStatus(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    } finally {
      setReloading(false);
    }
  };

  const toolCount = servers.reduce(
    (total, server) => total + server.tools.length,
    0,
  );
  const title = loading
    ? "MCP Tools"
    : `MCP Tools · ${servers.length} server${servers.length === 1 ? "" : "s"}`
      + ` · ${toolCount} tool${toolCount === 1 ? "" : "s"}`;

  return (
    <aside
      className={`live-work-rail mcp-inventory-panel${
        collapsed ? " live-work-rail--collapsed" : ""
      }`}
      aria-label={title}
    >
      <header className="live-work-rail__header">
        <button
          type="button"
          className="live-work-rail__collapse"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={() => setCollapsed((current) => !current)}
        >
          <span className="live-work-rail__chevron" aria-hidden="true" />
          <span className="live-work-rail__title">{title}</span>
        </button>
        <div className="live-work-rail__header-actions">
          <button
            type="button"
            className="mcp-inventory-panel__reload"
            aria-describedby={
              reloadTooltip.visible ? reloadTooltip.tooltipId : undefined
            }
            disabled={reloading || !props.desktopApi?.reloadCodexMcpConfig}
            onClick={() => void reloadConfig()}
            onMouseEnter={(event) =>
              reloadTooltip.show(event.currentTarget, RELOAD_TOOLTIP)
            }
            onMouseLeave={reloadTooltip.hide}
            onFocus={(event) =>
              reloadTooltip.show(event.currentTarget, RELOAD_TOOLTIP)
            }
            onBlur={reloadTooltip.hide}
          >
            {reloading ? "Reloading…" : "Reload Config"}
          </button>
          {reloadTooltip.tooltipNode}
          <button
            type="button"
            className="mcp-inventory-panel__dismiss"
            aria-label="Close MCP tools"
            title="Close MCP tools"
            onClick={props.onDismiss}
          >
            <CloseIcon size={13} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div id={bodyId} className="live-work-rail__body" hidden={collapsed}>
        {loading ? (
          <p className="mcp-inventory-panel__state" role="status">
            Reading MCP inventory…
          </p>
        ) : error ? (
          <p className="mcp-inventory-panel__state mcp-inventory-panel__state--error">
            {error}
          </p>
        ) : servers.length === 0 ? (
          <p className="mcp-inventory-panel__state">No MCP servers available.</p>
        ) : (
          <ul className="mcp-inventory-panel__servers">
            {servers.map((server) => (
              <McpServerRow
                key={server.name}
                detail={props.request.detail}
                server={server}
              />
            ))}
          </ul>
        )}
        {reloadStatus ? (
          <p className="mcp-inventory-panel__reload-status" role="status">
            {reloadStatus}
          </p>
        ) : null}
      </div>
    </aside>
  );
}

function McpServerRow(props: {
  detail: CodexMcpInventoryDetail;
  server: CodexMcpServerSummary;
}) {
  return (
    <li className="mcp-inventory-panel__server">
      <div className="mcp-inventory-panel__server-header">
        <span className="mcp-inventory-panel__server-name">{props.server.name}</span>
        <span className="mcp-inventory-panel__auth">
          {formatAuthStatus(props.server.authStatus)}
        </span>
      </div>
      <InventoryLine
        label="Tools"
        previewLimit={TOOL_PREVIEW_LIMIT}
        values={props.server.tools}
      />
      {props.detail === "full" ? (
        <>
          <InventoryLine
            label="Resources"
            previewLimit={CATALOG_PREVIEW_LIMIT}
            values={(props.server.resources ?? []).map((resource) =>
              `${resource.title ?? resource.name} (${resource.uri})`
            )}
          />
          <InventoryLine
            label="Templates"
            previewLimit={CATALOG_PREVIEW_LIMIT}
            values={(props.server.resourceTemplates ?? []).map((template) =>
              `${template.title ?? template.name} (${template.uriTemplate})`
            )}
          />
        </>
      ) : null}
    </li>
  );
}

function InventoryLine(props: {
  label: string;
  previewLimit: number;
  values: string[];
}) {
  const [expanded, setExpanded] = useState(false);
  const hasOverflow = props.values.length > props.previewLimit;
  const visibleValues = expanded || !hasOverflow
    ? props.values
    : props.values.slice(0, props.previewLimit);
  const hiddenCount = props.values.length - visibleValues.length;

  return (
    <div className="mcp-inventory-panel__line">
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

function formatAuthStatus(status: CodexMcpAuthStatus): string {
  switch (status) {
    case "notLoggedIn":
      return "Sign-in required";
    case "bearerToken":
      return "Bearer token";
    case "oAuth":
      return "OAuth";
    case "unsupported":
      return "No authentication";
  }
}
