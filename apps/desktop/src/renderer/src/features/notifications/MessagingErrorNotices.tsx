import { useCallback, useEffect, useRef, useState } from "react";
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

type MessagingPlatformNoticeState = {
  changedAt: number;
  notice?: AppNoticeToastNotice;
  source: "event" | "snapshot";
};

export function MessagingErrorNotices(props: {
  desktopApi?: DesktopApi;
  onNoticeChanged?: (
    platform: MessagingChannelKind,
    notice: AppNoticeToastNotice | undefined,
  ) => void;
}) {
  const onNoticeChanged = props.onNoticeChanged;
  const [statusByPlatform, setStatusByPlatform] = useState(
    () => new Map<MessagingChannelKind, MessagingPlatformNoticeState>(),
  );
  const publishedNoticeKeysRef = useRef(
    new Map<MessagingChannelKind, string>(),
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
        setStatusByPlatform((current) => applyStatusEvent(current, event));
      },
    );

    void props.desktopApi.getMessagingPlatformStatuses?.()
      .then((statuses) => {
        if (cancelled) {
          return;
        }
        setStatusByPlatform((current) => applyStatusSnapshot(current, statuses));
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
    setStatusByPlatform((current) => {
      const currentState = current.get(platform);
      if (!currentState?.notice) {
        return current;
      }
      const next = new Map(current);
      next.set(platform, { ...currentState, notice: undefined });
      return next;
    });
  }, []);

  const notices: MessagingErrorNotice[] = [];
  for (const [platform, state] of statusByPlatform) {
    if (state.notice) {
      notices.push({ notice: state.notice, platform });
    }
  }

  useEffect(() => {
    if (!onNoticeChanged) return;
    for (const [platform, state] of statusByPlatform) {
      const noticeKey = state.notice
        ? messagingNoticePublicationKey(state.notice)
        : `healthy:${state.changedAt}`;
      if (publishedNoticeKeysRef.current.get(platform) === noticeKey) {
        continue;
      }
      publishedNoticeKeysRef.current.set(platform, noticeKey);
      onNoticeChanged(platform, state.notice);
    }
  }, [onNoticeChanged, statusByPlatform]);

  if (onNoticeChanged) return null;

  return notices.map(({ notice, platform }) => (
    <AppNoticeToast
      key={platform}
      desktopApi={props.desktopApi}
      notice={notice}
      onDismiss={() => dismiss(platform)}
    />
  ));
}

function messagingNoticePublicationKey(
  notice: AppNoticeToastNotice,
): string {
  // The notice id stays stable so App's durable stack replaces the active
  // platform entry in place. Include visible content here so a materially new
  // failure is still published after an earlier notice was dismissed.
  return JSON.stringify({
    detail: notice.detail,
    id: notice.id,
    message: notice.message,
    title: notice.title,
    tone: notice.tone,
  });
}

function applyStatusSnapshot(
  current: Map<MessagingChannelKind, MessagingPlatformNoticeState>,
  statuses: MessagingPlatformStatus[],
): Map<MessagingChannelKind, MessagingPlatformNoticeState> {
  let next = current;
  for (const status of statuses) {
    next = applyPlatformHealth(next, status, "snapshot");
  }
  return next;
}

function applyStatusEvent(
  current: Map<MessagingChannelKind, MessagingPlatformNoticeState>,
  event: Extract<MessagingPlatformStatusEvent, { kind: "health-changed" }>,
): Map<MessagingChannelKind, MessagingPlatformNoticeState> {
  return applyPlatformHealth(current, {
    platform: event.platform,
    health: event.health,
    changedAt: event.at,
    reason: event.reason,
    startupFailure: event.startupFailure,
  }, "event");
}

function applyPlatformHealth(
  current: Map<MessagingChannelKind, MessagingPlatformNoticeState>,
  status: Pick<
    MessagingPlatformStatus,
    "changedAt" | "health" | "platform" | "reason" | "startupFailure"
  >,
  source: MessagingPlatformNoticeState["source"],
): Map<MessagingChannelKind, MessagingPlatformNoticeState> {
  const previous = current.get(status.platform);
  if (
    previous
    && (
      status.changedAt < previous.changedAt
      || (
        status.changedAt === previous.changedAt
        && previous.source === "event"
        && source === "snapshot"
      )
    )
  ) {
    return current;
  }

  const notice = (
    status.health === "errored"
    || (status.health === "suspended" && status.startupFailure === true)
  )
    ? buildMessagingErrorNotice(status)
    : undefined;
  if (
    previous?.changedAt === status.changedAt
    && previous.notice?.id === notice?.id
    && previous.source === source
  ) {
    return current;
  }
  const next = new Map(current);
  next.set(status.platform, {
    changedAt: status.changedAt,
    notice,
    source,
  });
  return next;
}

export function buildMessagingErrorNotice(
  status: Pick<
    MessagingPlatformStatus,
    "changedAt" | "platform" | "reason" | "startupFailure"
  >,
): AppNoticeToastNotice {
  const platformName = formatMessagingPlatformName(status.platform);
  return {
    autoDismiss: false,
    detail: status.reason?.trim() || undefined,
    id: `messaging-platform-error:${status.platform}:active`,
    message: status.startupFailure
      ? `PwrAgent could not complete messaging startup for ${platformName}. `
        + "Messages may be unavailable until it starts successfully."
      : `${platformName} reported an adapter error. Messages may be unavailable `
        + "until it recovers or is restarted.",
    title: `${platformName} messaging failed`,
    tone: "error",
  };
}
