import { useEffect, useRef, useState } from "react";
import type { AgentEvent } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import type { ResolvedThreadLink } from "../../lib/thread-links";
import { AppNoticeToast, type AppNoticeToastNotice } from "./AppNoticeToast";

type PendingRename = {
  key: string;
  title: string;
  undoing: boolean;
};

function renameKey(event: AgentEvent, threadId: string): string {
  const instance = event.federationTarget?.scope === "remote"
    ? event.federationTarget.instanceId
    : "local";
  return `${instance}:${event.backend}:${threadId}`;
}

/** A single transient producer slot; rename notices never enter durable state. */
export function AgentThreadRenameNotice(props: {
  desktopApi?: Pick<DesktopApi, "onAgentEvent" | "renameThread" | "copyText">;
  onOpenThread?: (link: ResolvedThreadLink) => void;
}) {
  const [notice, setNotice] = useState<AppNoticeToastNotice>();
  const pending = useRef<PendingRename | undefined>(undefined);
  const { desktopApi } = props;

  useEffect(() => {
    let sequence = 0;
    const unsubscribe = desktopApi?.onAgentEvent?.((event) => {
      if (event.notification.method !== "thread/name/updated") return;
      const params = event.notification.params as {
        threadId?: string;
        threadName?: string;
        renameOrigin?: string;
        previousThreadName?: string;
      };
      if (typeof params.threadId !== "string" || typeof params.threadName !== "string") return;
      const title = params.threadName.trim();
      if (!title) return;
      const key = renameKey(event, params.threadId);
      if (pending.current?.key === key && pending.current.title !== title) {
        pending.current = undefined;
        setNotice(undefined);
      }
      // Provider echoes of the same name must not clear the host's notice.
      if (params.renameOrigin !== "agent_tool") return;
      const previousTitle = typeof params.previousThreadName === "string"
        ? params.previousThreadName.trim()
        : undefined;
      if (previousTitle === title) return;
      const current: PendingRename = { key, title, undoing: false };
      pending.current = current;
      const identity = {
        backend: event.backend,
        threadId: params.threadId,
        ...(event.federationTarget ? { federationTarget: event.federationTarget } : {}),
      };
      const next: AppNoticeToastNotice = {
        id: `agent-thread-rename:${key}:${++sequence}`,
        title: "Thread renamed",
        message: previousTitle
          ? `Renamed “${previousTitle}” → “${title}”.`
          : `Renamed this thread to “${title}”.`,
        tone: "neutral",
        threadLink: {
          backend: event.backend,
          threadId: params.threadId,
          title,
          ...(event.federationTarget?.scope === "remote"
            ? { instanceId: event.federationTarget.instanceId }
            : {}),
        },
      };
      const renameThread = desktopApi.renameThread;
      if (previousTitle && renameThread) {
        next.actions = [{
          label: "Undo",
          onClick: () => {
            if (pending.current !== current || current.undoing) return;
            current.undoing = true;
            void (async () => {
              await renameThread({ ...identity, name: previousTitle, expectedName: title });
              if (pending.current === current) {
                pending.current = undefined;
                setNotice(undefined);
              }
            })().catch((error: unknown) => {
              if (pending.current !== current) return;
              current.undoing = false;
              setNotice({
                ...next,
                autoDismiss: false,
                title: "Could not undo thread rename",
                message: error instanceof Error ? error.message : String(error),
                tone: "error",
              });
            });
          },
        }];
      }
      setNotice(next);
    });
    return () => {
      pending.current = undefined;
      unsubscribe?.();
    };
  }, [desktopApi]);

  return (
    <AppNoticeToast
      desktopApi={desktopApi}
      notice={notice}
      onOpenThread={props.onOpenThread}
      onDismiss={() => {
        pending.current = undefined;
        setNotice(undefined);
      }}
    />
  );
}
