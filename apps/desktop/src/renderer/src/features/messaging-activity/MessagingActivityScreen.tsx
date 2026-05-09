import { useCallback, useEffect, useState } from "react";
import type {
  MessagingActivityEntry,
  MessagingActivityKind,
} from "@pwragent/shared";
import { DiscordIcon, MattermostIcon, TelegramIcon } from "../../icons";
import { copyText } from "../../lib/copy-text";
import type { DesktopApi } from "../../lib/desktop-api";

const REFRESH_INTERVAL_MS = 5_000;
const KIND_LABEL: Record<MessagingActivityKind, string> = {
  "inbound-routed": "Routed",
  "inbound-rejected": "Rejected",
  "inbound-ignored": "Ignored",
  pairing: "Pairing",
  outbound: "Sent",
};
const KIND_TONE: Record<MessagingActivityKind, "ok" | "warning" | "error" | "muted"> = {
  "inbound-routed": "ok",
  "inbound-rejected": "error",
  "inbound-ignored": "warning",
  pairing: "warning",
  outbound: "muted",
};

/**
 * Read-only view of the recent messaging activity log: routed inbound,
 * rejected inbound (unauthorized senders), ignored inbound (post-revoke),
 * and outbound deliveries. Capped per-platform via FIFO eviction in the
 * sqlite GC pass — anything older than the cap is gone.
 *
 * Polls every 5s while open. The renderer doesn't subscribe to a push
 * event because the activity log writes are best-effort and a dropped
 * tick is fine (we'll catch up on the next poll).
 */
export function MessagingActivityScreen(props: { desktopApi?: DesktopApi }) {
  const desktopApi = props.desktopApi;
  const [entries, setEntries] = useState<MessagingActivityEntry[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!desktopApi?.listMessagingActivity) return;
    setLoading(true);
    setError(undefined);
    try {
      const result = await desktopApi.listMessagingActivity({ limit: 200 });
      setEntries(result.entries);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
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

  return (
    <section className="messaging-activity" aria-label="Messaging activity">
      {/* Pinned header card — eyebrow + title + helper paragraph + Refresh. */}
      <section
        className="settings-panel messaging-activity__head"
        aria-labelledby="messaging-activity-title"
      >
        <div className="settings-panel__header">
          <div>
            <p className="eyebrow">Messaging</p>
            <h2 id="messaging-activity-title">Activity</h2>
          </div>
          <button
            className="button button--secondary"
            disabled={loading || !desktopApi?.listMessagingActivity}
            type="button"
            onClick={() => void refresh()}
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
        <p className="settings-panel__hint">
          Last {entries.length} events across all configured messaging platforms.
          Capped per-platform with FIFO eviction; older history is not retained.
        </p>
        {error ? (
          <p className="settings-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      {/* Primary list — fills available height with internal scroll. */}
      <ActivitySection
        className="messaging-activity__main"
        title="Currently bound"
        emptyLabel="No bound conversations have sent messages recently."
        kinds={["inbound-routed", "outbound"]}
        groups={groups}
      />

      {/* Secondary list — capped at ~5 rows tall; internal scroll if longer.
          Stays pinned to the bottom of the pane. */}
      <ActivitySection
        className="messaging-activity__aside"
        title="Received but ignored"
        emptyLabel="No rejected or ignored inbound messages — your authorization list is doing its job."
        kinds={["inbound-rejected", "inbound-ignored", "pairing"]}
        groups={groups}
      />
    </section>
  );
}

function ActivitySection(props: {
  className?: string;
  title: string;
  emptyLabel: string;
  kinds: MessagingActivityKind[];
  groups: Record<MessagingActivityKind, MessagingActivityEntry[]>;
}) {
  const entries = props.kinds.flatMap((kind) => props.groups[kind] ?? []);
  entries.sort((left, right) => right.createdAt - left.createdAt);
  const className = `settings-panel${props.className ? ` ${props.className}` : ""}`;
  return (
    <section className={className} aria-label={props.title}>
      <div className="settings-panel__header">
        <div>
          <p className="eyebrow">Messaging</p>
          <h2>{props.title}</h2>
        </div>
      </div>
      {entries.length === 0 ? (
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
  return (
    <li className="messaging-activity-row">
      <span className={`messaging-activity-row__icon messaging-activity-row__icon--${tone}`}>
        {entry.platform === "telegram" ? (
          <TelegramIcon size={14} variant="color" />
        ) : entry.platform === "discord" ? (
          <DiscordIcon size={14} variant="white" />
        ) : entry.platform === "mattermost" ? (
          <MattermostIcon size={14} />
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
  if (entry.actorId) {
    fields.push({
      key: "actor",
      label: userIdLabel(entry.platform),
      value: entry.actorId,
    });
  }

  const conversationKind =
    typeof entry.payload?.conversationKind === "string"
      ? entry.payload.conversationKind
      : undefined;
  const parentId =
    typeof entry.payload?.conversationParentId === "string"
      ? entry.payload.conversationParentId
      : undefined;

  if (parentId) {
    fields.push({
      key: "parent",
      label: parentIdLabel(entry.platform, conversationKind),
      value: parentId,
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
  if (platform === "mattermost") return "User ID";
  return "Actor ID";
}

function parentIdLabel(
  platform: MessagingActivityEntry["platform"],
  conversationKind?: string,
): string {
  if (platform === "telegram") return "Supergroup ID";
  if (platform === "discord") return "Guild ID";
  if (platform === "mattermost" && conversationKind === "thread") return "Root ID";
  return "Parent ID";
}

function conversationIdLabel(
  platform: MessagingActivityEntry["platform"],
  conversationKind?: string,
): string {
  if (platform === "telegram" && conversationKind !== "dm") {
    return conversationKind === "topic" ? "Topic ID" : "Supergroup ID";
  }
  if (platform === "discord" && conversationKind !== "dm") return "Channel ID";
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
