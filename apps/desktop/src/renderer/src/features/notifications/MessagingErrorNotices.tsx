import { useCallback, useEffect, useState } from "react";
import type {
  MessagingChannelKind,
  MessagingPlatformStatus,
  MessagingPlatformStatusEvent,
} from "@pwragent/shared";
import { formatMessagingPlatformName } from "../../lib/messaging-platform-branding";
import type { DesktopApi } from "../../lib/desktop-api";
import { AppNoticeToast, type AppNoticeToastNotice } from "./AppNoticeToast";

type MessagingErrorNotice = {
  notice: AppNoticeToastNotice;
  platform: MessagingChannelKind;
};

export function MessagingErrorNotices(props: {
  desktopApi?: DesktopApi;
}) {
  const [noticesByPlatform, setNoticesByPlatform] = useState(
    () => new Map<MessagingChannelKind, AppNoticeToastNotice>(),
  );

  useEffect(() => {
    if (
      !props.desktopApi?.getMessagingPlatformStatuses
      && !props.desktopApi?.onMessagingPlatformStatusEvent
    ) {
      return;
    }

    let cancelled = false;
    const unsubscribe = props.desktopApi.onMessagingPlatformStatusEvent?.(
      (event: MessagingPlatformStatusEvent) => {
        if (event.kind !== "health-changed") {
          return;
        }
        setNoticesByPlatform((current) => applyStatusEvent(current, event));
      },
    );

    void props.desktopApi.getMessagingPlatformStatuses?.()
      .then((statuses) => {
        if (cancelled) {
          return;
        }
        setNoticesByPlatform((current) => applyStatusSnapshot(current, statuses));
      })
      .catch(() => {
        // Logged in main; a later pushed health event can still surface an error.
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [props.desktopApi]);

  const dismiss = useCallback((platform: MessagingChannelKind) => {
    setNoticesByPlatform((current) => {
      if (!current.has(platform)) {
        return current;
      }
      const next = new Map(current);
      next.delete(platform);
      return next;
    });
  }, []);

  const notices: MessagingErrorNotice[] = Array.from(
    noticesByPlatform,
    ([platform, notice]) => ({ notice, platform }),
  );

  return notices.map(({ notice, platform }) => (
    <AppNoticeToast
      key={platform}
      desktopApi={props.desktopApi}
      notice={notice}
      onDismiss={() => dismiss(platform)}
    />
  ));
}

function applyStatusSnapshot(
  current: Map<MessagingChannelKind, AppNoticeToastNotice>,
  statuses: MessagingPlatformStatus[],
): Map<MessagingChannelKind, AppNoticeToastNotice> {
  let next = current;
  for (const status of statuses) {
    next = applyPlatformHealth(next, status);
  }
  return next;
}

function applyStatusEvent(
  current: Map<MessagingChannelKind, AppNoticeToastNotice>,
  event: Extract<MessagingPlatformStatusEvent, { kind: "health-changed" }>,
): Map<MessagingChannelKind, AppNoticeToastNotice> {
  return applyPlatformHealth(current, {
    platform: event.platform,
    health: event.health,
    changedAt: event.at,
    reason: event.reason,
  });
}

function applyPlatformHealth(
  current: Map<MessagingChannelKind, AppNoticeToastNotice>,
  status: Pick<
    MessagingPlatformStatus,
    "changedAt" | "health" | "platform" | "reason"
  >,
): Map<MessagingChannelKind, AppNoticeToastNotice> {
  if (status.health !== "errored") {
    if (!current.has(status.platform)) {
      return current;
    }
    const next = new Map(current);
    next.delete(status.platform);
    return next;
  }

  const nextNotice = buildMessagingErrorNotice(status);
  if (current.get(status.platform)?.id === nextNotice.id) {
    return current;
  }
  const next = new Map(current);
  next.set(status.platform, nextNotice);
  return next;
}

export function buildMessagingErrorNotice(
  status: Pick<
    MessagingPlatformStatus,
    "changedAt" | "platform" | "reason"
  >,
): AppNoticeToastNotice {
  const platformName = formatMessagingPlatformName(status.platform);
  return {
    autoDismiss: false,
    detail: status.reason?.trim() || undefined,
    id: `messaging-platform-error:${status.platform}:${status.changedAt}`,
    message:
      `${platformName} isn't listening for messages and won't retry automatically. `
      + `Fix the problem, then restart PwrAgent or turn ${platformName} off and back on.`,
    title: `${platformName} messaging failed`,
    tone: "error",
  };
}
