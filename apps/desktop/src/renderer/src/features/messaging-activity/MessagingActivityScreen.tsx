import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  MessagingActivityEntry,
  MessagingActivityKind,
} from "@pwragent/shared";
import { copyText } from "../../lib/copy-text";
import type { DesktopApi } from "../../lib/desktop-api";
import { ChevronRightIcon } from "../../icons";
import {
  formatMessagingPlatformName,
  MESSAGING_PLATFORM_ICONS,
} from "../../lib/messaging-platform-branding";

const REFRESH_INTERVAL_MS = 5_000;
const KIND_LABEL: Record<MessagingActivityKind, string> = {
  "inbound-routed": "Routed",
  "inbound-rejected": "Rejected",
  "inbound-ignored": "Ignored",
  pairing: "Pairing",
  outbound: "Sent",
  binding: "Binding",
  diagnostic: "Diagnostic",
};
const KIND_TONE: Record<MessagingActivityKind, "ok" | "warning" | "error" | "muted"> = {
  "inbound-routed": "ok",
  "inbound-rejected": "error",
  "inbound-ignored": "warning",
  pairing: "warning",
  outbound: "muted",
  binding: "ok",
  diagnostic: "warning",
};
/** Which pane, if any, is collapsed to header-only. */
type CollapsedPane = "top" | "bottom" | null;

const MIN_SPLIT = 0.15;
const MAX_SPLIT = 0.85;
const DEFAULT_SPLIT = 0.62;

/**
 * Read-only view of the recent messaging activity log: routed inbound,
 * rejected inbound (unauthorized senders), ignored inbound (post-revoke),
 * and outbound deliveries. Capped per-platform via FIFO eviction in the
 * sqlite GC pass — anything older than the cap is gone.
 *
 * Polls every 5s while open. The renderer doesn't subscribe to a push
 * event because the activity log writes are best-effort and a dropped
 * tick is fine (we'll catch up on the next poll). No manual Refresh
 * control — the 5s poll keeps the two panes current on its own.
 *
 * The body is two panes — "Bound activity" and "Attention" — split by a
 * draggable divider; each pane header is a collapse toggle so the other
 * pane can take the full height.
 */
export function MessagingActivityScreen(props: { desktopApi?: DesktopApi }) {
  const desktopApi = props.desktopApi;
  const [entries, setEntries] = useState<MessagingActivityEntry[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!desktopApi?.listMessagingActivity) return;
    setError(undefined);
    try {
      const result = await desktopApi.listMessagingActivity({ limit: 200 });
      setEntries(result.entries);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [desktopApi]);

  useEffect(() => {
    void refresh();
    const intervalId = window.setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [refresh]);

  const groups = groupByKind(entries);

  // Split between the two panes. `splitFraction` is the top pane's share of
  // the container height when neither pane is collapsed; the divider drags it.
  // Collapsing a pane pins it to header height and lets the other fill.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [splitFraction, setSplitFraction] = useState(DEFAULT_SPLIT);
  const [collapsed, setCollapsed] = useState<CollapsedPane>(null);

  const toggleCollapse = useCallback((pane: Exclude<CollapsedPane, null>) => {
    setCollapsed((current) => (current === pane ? null : pane));
  }, []);

  const startDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) return;
    event.preventDefault();
    const rect = container.getBoundingClientRect();
    const onMove = (move: PointerEvent) => {
      if (rect.height <= 0) return;
      const fraction = (move.clientY - rect.top) / rect.height;
      setSplitFraction(Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, fraction)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "row-resize";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  return (
    <section
      className="messaging-activity"
      aria-label="Messaging activity"
      ref={containerRef}
    >
      {error ? (
        <p className="settings-error messaging-activity__error" role="alert">
          {error}
        </p>
      ) : null}

      {/* Primary list. */}
      <ActivitySection
        className="messaging-activity__pane messaging-activity__pane--top"
        style={paneStyleFor("top", collapsed, splitFraction)}
        title="Bound activity"
        emptyLabel="No bound conversations have sent messages recently."
        kinds={["binding", "inbound-routed", "outbound"]}
        groups={groups}
        collapsed={collapsed === "top"}
        onToggleCollapse={() => toggleCollapse("top")}
      />

      {/* Draggable divider — only meaningful when both panes are open. */}
      {collapsed === null ? (
        <div
          className="messaging-activity__divider"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize sections"
          onPointerDown={startDrag}
        >
          <span className="messaging-activity__divider-grip" aria-hidden="true" />
        </div>
      ) : null}

      {/* Secondary list — rejections, pairing, delivery diagnostics. */}
      <ActivitySection
        className="messaging-activity__pane messaging-activity__pane--bottom"
        style={paneStyleFor("bottom", collapsed, splitFraction)}
        title="Attention"
        emptyLabel="No rejected messages, pairing attempts, or delivery diagnostics."
        kinds={["diagnostic", "inbound-rejected", "inbound-ignored", "pairing"]}
        groups={groups}
        collapsed={collapsed === "bottom"}
        onToggleCollapse={() => toggleCollapse("bottom")}
      />
    </section>
  );
}

/**
 * Flex sizing for one pane given the collapse state:
 * - this pane collapsed → header height only (`flex: 0 0 auto`).
 * - the other pane collapsed → fill the remaining space.
 * - neither collapsed → share the container by `splitFraction`.
 */
function paneStyleFor(
  pane: Exclude<CollapsedPane, null>,
  collapsed: CollapsedPane,
  splitFraction: number,
): CSSProperties {
  if (collapsed === pane) return { flex: "0 0 auto" };
  if (collapsed !== null) return { flexGrow: 1, flexBasis: 0, minHeight: 0 };
  const grow = pane === "top" ? splitFraction : 1 - splitFraction;
  return { flexGrow: grow, flexBasis: 0, minHeight: 0 };
}

function ActivitySection(props: {
  className?: string;
  style?: CSSProperties;
  title: string;
  emptyLabel: string;
  kinds: MessagingActivityKind[];
  groups: Record<MessagingActivityKind, MessagingActivityEntry[]>;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const entries = props.kinds.flatMap((kind) => props.groups[kind] ?? []);
  entries.sort((left, right) => right.createdAt - left.createdAt);
  const className = `settings-panel${props.className ? ` ${props.className}` : ""}`;
  return (
    <section className={className} style={props.style} aria-label={props.title}>
      <button
        type="button"
        className="messaging-activity-pane__header"
        aria-expanded={!props.collapsed}
        onClick={props.onToggleCollapse}
      >
        <ChevronRightIcon
          size={14}
          className={`messaging-activity-pane__chevron${
            props.collapsed ? "" : " messaging-activity-pane__chevron--open"
          }`}
        />
        <h2>{props.title}</h2>
        <span className="messaging-activity-pane__count">{entries.length}</span>
      </button>
      {props.collapsed ? null : entries.length === 0 ? (
        <p className="settings-empty messaging-activity-empty">{props.emptyLabel}</p>
      ) : (
        <ul className="messaging-activity-list">
          {entries.map((entry) => (
            <ActivityRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ActivityRow(props: { entry: MessagingActivityEntry }) {
  const { entry } = props;
  const tone = KIND_TONE[entry.kind];
  const [copiedKey, setCopiedKey] = useState<string | undefined>(undefined);
  const copyFields = copyFieldsForEntry(entry);
  const Icon = MESSAGING_PLATFORM_ICONS[entry.platform];
  return (
    <li className="messaging-activity-row">
      <span className={`messaging-activity-row__icon messaging-activity-row__icon--${tone}`}>
        {Icon ? (
          <Icon size={14} />
        ) : (
          <span>{entry.platform.slice(0, 2)}</span>
        )}
      </span>
      <div className="messaging-activity-row__body">
        <div className="messaging-activity-row__line">
          <span className={`settings-pill settings-pill--${tone === "ok" ? "ok" : tone === "warning" ? "warn" : tone === "error" ? "bad" : "neutral"}`}>
            {KIND_LABEL[entry.kind]}
          </span>
          <span className="messaging-activity-row__summary">{entry.summary}</span>
        </div>
        <div className="messaging-activity-row__meta">
          {entry.conversationTitle ?? entry.conversationId ?? "—"}
          {" · "}
          {formatRelative(entry.createdAt)}
        </div>
        {copyFields.length > 0 ? (
          <div className="messaging-activity-row__ids" aria-label="Copy identifiers">
            {copyFields.map((field) => (
              <button
                key={field.key}
                className="messaging-activity-row__copy"
                type="button"
                onClick={() => {
                  void copyText(field.value).then(() => {
                    setCopiedKey(field.key);
                    window.setTimeout(() => {
                      setCopiedKey((current) =>
                        current === field.key ? undefined : current,
                      );
                    }, 1200);
                  });
                }}
              >
                <span>{field.label}</span>
                <code>{field.value}</code>
                <span className="messaging-activity-row__copy-state">
                  {copiedKey === field.key ? "Copied" : "Copy"}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function copyFieldsForEntry(
  entry: MessagingActivityEntry,
): Array<{ key: string; label: string; value: string }> {
  const fields: Array<{ key: string; label: string; value: string }> = [];
  const conversationKind =
    typeof entry.payload?.conversationKind === "string"
      ? entry.payload.conversationKind
      : undefined;
  const parentId =
    typeof entry.payload?.conversationParentId === "string"
      ? entry.payload.conversationParentId
      : undefined;
  const bucketId =
    typeof entry.payload?.conversationBucketId === "string"
      ? entry.payload.conversationBucketId
      : undefined;
  const conversationTitle =
    typeof entry.payload?.conversationTitle === "string"
      ? entry.payload.conversationTitle
      : entry.conversationTitle;
  const localThreadTitle =
    typeof entry.payload?.localThreadTitle === "string"
      ? entry.payload.localThreadTitle
      : undefined;

  if (entry.kind === "diagnostic") {
    fields.push({
      key: "provider",
      label: "Provider",
      value: formatMessagingPlatformName(entry.platform),
    });
    if (conversationTitle) {
      fields.push({
        key: "conversation-title",
        label: "Conversation",
        value: conversationTitle,
      });
    }
    if (localThreadTitle) {
      fields.push({
        key: "local-thread-title",
        label: "Thread",
        value: localThreadTitle,
      });
    }
  }
  if (entry.actorId) {
    fields.push({
      key: "actor",
      label: userIdLabel(entry.platform),
      value: entry.actorId,
    });
  }
  if (entry.kind === "diagnostic") {
    if (entry.bindingId) {
      fields.push({
        key: "binding",
        label: "Binding ID",
        value: entry.bindingId,
      });
    }
    if (entry.threadId) {
      fields.push({
        key: "thread",
        label: "Thread ID",
        value: entry.threadId,
      });
    }
  }

  if (parentId) {
    fields.push({
      key: "parent",
      label: parentIdLabel(entry.platform, conversationKind),
      value: parentId,
    });
  }
  if (bucketId && bucketId !== parentId && bucketId !== entry.conversationId) {
    fields.push({
      key: "bucket",
      label: bucketIdLabel(entry.platform),
      value: bucketId,
    });
  }
  if (entry.conversationId) {
    fields.push({
      key: "conversation",
      label: conversationIdLabel(entry.platform, conversationKind),
      value: entry.conversationId,
    });
  }

  return fields;
}

function userIdLabel(platform: MessagingActivityEntry["platform"]): string {
  if (platform === "telegram") return "Peer ID";
  if (platform === "discord") return "User ID";
  if (platform === "slack") return "User ID";
  if (platform === "feishu") return "Open ID";
  if (platform === "mattermost") return "User ID";
  return "Actor ID";
}

function parentIdLabel(
  platform: MessagingActivityEntry["platform"],
  conversationKind?: string,
): string {
  if (platform === "telegram") return "Supergroup ID";
  if (platform === "discord") return "Guild ID";
  if (platform === "feishu") return "Tenant Key";
  if (platform === "mattermost" && conversationKind === "thread") return "Root ID";
  return "Parent ID";
}

function bucketIdLabel(platform: MessagingActivityEntry["platform"]): string {
  if (platform === "telegram") return "Supergroup ID";
  if (platform === "discord") return "Guild ID";
  if (platform === "slack") return "Workspace ID";
  if (platform === "feishu") return "Tenant Key";
  if (platform === "mattermost") return "Team ID";
  return "Bucket ID";
}

function conversationIdLabel(
  platform: MessagingActivityEntry["platform"],
  conversationKind?: string,
): string {
  if (platform === "telegram" && conversationKind !== "dm") {
    return conversationKind === "topic" ? "Topic ID" : "Supergroup ID";
  }
  if (platform === "discord" && conversationKind !== "dm") return "Channel ID";
  if (platform === "slack" && conversationKind !== "dm") return "Channel ID";
  if (platform === "feishu" && conversationKind !== "dm") return "Chat ID";
  if (platform === "mattermost" && conversationKind !== "dm") return "Channel ID";
  return "Conversation ID";
}

function groupByKind(
  entries: MessagingActivityEntry[],
): Record<MessagingActivityKind, MessagingActivityEntry[]> {
  const groups: Record<MessagingActivityKind, MessagingActivityEntry[]> = {
    "inbound-routed": [],
    "inbound-rejected": [],
    "inbound-ignored": [],
    pairing: [],
    outbound: [],
    binding: [],
    diagnostic: [],
  };
  for (const entry of entries) {
    groups[entry.kind]?.push(entry);
  }
  return groups;
}

function formatRelative(timestamp: number): string {
  const deltaSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  const deltaDays = Math.round(deltaHours / 24);
  return `${deltaDays}d ago`;
}
