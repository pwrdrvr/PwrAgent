import { useEffect, useState } from "react";
import {
  quitBlockerItemKey,
  type QuitBlockerItem,
  type QuitBlockerKind,
  type QuitBlockerQueueSnapshot,
} from "../../../../shared/quit-blockers";
import type { DesktopApi } from "../../lib/desktop-api";
import { AppNoticeToast } from "./AppNoticeToast";

const REFRESH_INTERVAL_MS = 500;

const GROUPS: ReadonlyArray<{
  kind: QuitBlockerKind;
  heading: string;
}> = [
  { kind: "turn", heading: "Agent turns in progress" },
  { kind: "automation", heading: "Automations in progress" },
  { kind: "terminal", heading: "Integrated terminals" },
  { kind: "action", heading: "Environment actions" },
];

type QuitBlockerQueueApi = Pick<
  DesktopApi,
  | "copyText"
  | "onShowQuitBlockersRequested"
  | "readQuitBlockerQueue"
  | "revealQuitBlocker"
>;

export function QuitBlockerQueueToast(props: {
  desktopApi?: QuitBlockerQueueApi;
}) {
  const [snapshot, setSnapshot] = useState<QuitBlockerQueueSnapshot>();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    return props.desktopApi?.onShowQuitBlockersRequested?.((nextSnapshot) => {
      setSnapshot(nextSnapshot);
      setVisible(true);
    });
  }, [props.desktopApi]);

  useEffect(() => {
    if (!visible || !props.desktopApi?.readQuitBlockerQueue) return;
    const readQuitBlockerQueue = props.desktopApi.readQuitBlockerQueue;
    let disposed = false;
    let inFlight = false;
    const refresh = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const nextSnapshot = await readQuitBlockerQueue();
        if (!disposed) {
          setSnapshot(nextSnapshot);
        }
      } catch {
        // Keep the last authoritative snapshot visible. The next interval can
        // recover without making a transient IPC failure dismiss the queue.
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const interval = window.setInterval(
      () => void refresh(),
      REFRESH_INTERVAL_MS,
    );
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [props.desktopApi, visible]);

  if (!visible || !snapshot) return null;

  const total =
    snapshot.inProgressThreadCount
    + snapshot.automationRunCount
    + snapshot.terminalSessionCount
    + snapshot.actionRunCount;
  const message = total === 0
    ? "No running work."
    : `${total} ${total === 1 ? "item is" : "items are"} still running.`;
  const copyText = [
    "Running work",
    message,
    ...snapshot.items.map((item) =>
      [item.title?.trim() || item.threadId, item.detail]
        .filter(Boolean)
        .join(" — ")
    ),
  ].join("\n");

  return (
    <AppNoticeToast
      desktopApi={props.desktopApi}
      notice={{
        id: "quit-blocker-queue",
        title: "Running work",
        message,
        copyText,
        tone: total === 0 ? "success" : "warning",
        autoDismiss: false,
      }}
      onDismiss={() => setVisible(false)}
    >
      <div className="quit-blocker-queue" data-testid="quit-blocker-queue">
        {total === 0 ? (
          <p className="quit-blocker-queue__empty">
            PwrAgent can quit without interrupting work.
          </p>
        ) : (
          <div className="quit-blocker-queue__list">
            {GROUPS.map((group) => {
              const items = snapshot.items.filter(
                (item) => item.kind === group.kind,
              );
              if (items.length === 0) return null;
              return (
                <section
                  className="quit-blocker-queue__group"
                  key={group.kind}
                >
                  <p className="quit-blocker-queue__heading">
                    {group.heading}
                  </p>
                  {items.map((item) => (
                    <QuitBlockerRow
                      item={item}
                      key={quitBlockerItemKey(item)}
                      onReveal={(selected) => {
                        void props.desktopApi?.revealQuitBlocker?.({
                          kind: selected.kind,
                          threadKey: selected.threadKey,
                          ...(selected.target
                            ? { target: selected.target }
                            : {}),
                        });
                      }}
                    />
                  ))}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </AppNoticeToast>
  );
}

function QuitBlockerRow(props: {
  item: QuitBlockerItem;
  onReveal: (item: QuitBlockerItem) => void;
}) {
  const label = props.item.title?.trim() || props.item.threadId;
  return (
    <button
      className="quit-blocker-queue__row"
      type="button"
      onClick={() => props.onReveal(props.item)}
    >
      <span className="quit-blocker-queue__row-heading">
        <span className="quit-blocker-queue__label">{label}</span>
        {props.item.isSubAgent ? (
          <span className="quit-blocker-queue__chip">Sub-agent</span>
        ) : null}
      </span>
      {props.item.detail ? (
        <span className="quit-blocker-queue__detail">{props.item.detail}</span>
      ) : null}
    </button>
  );
}
