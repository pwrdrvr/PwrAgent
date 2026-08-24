import { useEffect, useRef, useState } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  CopyIcon,
} from "../../icons";
import { copyText } from "../../lib/copy-text";
import type { DesktopApi } from "../../lib/desktop-api";
import type { ResolvedThreadLink } from "../../lib/thread-links";
import { ThreadChip } from "../thread-detail/ThreadChip";

const AUTO_DISMISS_MS = 9_000;

export type AppNoticeToastNotice = {
  actions?: readonly {
    label: string;
    onClick: () => void;
    tone?: "primary" | "secondary";
  }[];
  autoDismiss?: boolean;
  /** Retain only the highest-priority durable notice in this logical slot. */
  coalescing?: {
    key: string;
    priority: number;
  };
  /** Offers one action that dismisses every durable notice in this group. */
  dismissGroup?: {
    key: string;
    label: string;
  };
  id: string;
  title: string;
  message: string;
  /** Optional notice-specific dismissal, including any durable disposition. */
  onDismiss?: () => void;
  detail?: string;
  threadLink?: ResolvedThreadLink;
  copyText?: string;
  tone?: "neutral" | "warning" | "success" | "error";
  status?: {
    label: string;
    state: "progress" | "success" | "error";
  };
  /** At most one auto-dismissing notice is retained for a producer slot. */
  transientSlot?: string;
};

export function AppNoticeToast(props: {
  desktopApi?: Pick<DesktopApi, "copyText">;
  navigation?: {
    current: number;
    total: number;
    dismissAll?: {
      label: string;
      onDismiss: () => void;
    };
    onPrevious?: () => void;
    onNext?: () => void;
  };
  notice?: AppNoticeToastNotice;
  onDismiss: () => void;
  onOpenThread?: (link: ResolvedThreadLink) => void;
}) {
  const [paused, setPaused] = useState(false);
  const timeoutRef = useRef<number | undefined>(undefined);
  const onDismissRef = useRef(props.onDismiss);
  const noticeId = props.notice?.id;
  const noticePresent = props.notice !== undefined;
  const autoDismiss = props.notice?.autoDismiss !== false;

  useEffect(() => {
    onDismissRef.current = props.onDismiss;
  }, [props.onDismiss]);

  useEffect(() => {
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = undefined;
    }
    setPaused(false);
  }, [props.notice?.id]);

  useEffect(() => {
    if (!noticePresent || !autoDismiss || paused) {
      return;
    }

    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = undefined;
      onDismissRef.current();
    }, AUTO_DISMISS_MS);

    return () => {
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = undefined;
      }
    };
  }, [autoDismiss, noticeId, noticePresent, paused]);

  if (!props.notice) {
    return null;
  }

  const copyValue =
    props.notice.copyText ??
    [
      props.notice.title,
      props.notice.status?.label,
      props.notice.message,
      props.notice.detail,
    ]
      .filter(Boolean)
      .join("\n");
  const customActions = props.notice.actions ?? [];
  const hasFooterActions = customActions.length > 0
    || props.navigation?.dismissAll !== undefined;
  const statusDotClass =
    props.notice.status?.state === "progress"
      ? "status-dot status-dot--warning status-dot--blink"
      : props.notice.status?.state === "success"
        ? "status-dot status-dot--ok"
        : "status-dot status-dot--error";

  return (
    <aside
      className="app-notice-toast"
      data-navigable={props.navigation ? "true" : undefined}
      data-tone={props.notice.tone ?? "neutral"}
      role="status"
      aria-live="polite"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setPaused(false);
        }
      }}
    >
      <div className="app-notice-toast__content">
        <p className="app-notice-toast__eyebrow">{props.notice.title}</p>
        {props.notice.status ? (
          <p
            className="app-notice-toast__status"
            data-state={props.notice.status.state}
          >
            <span className={statusDotClass} aria-hidden="true" />
            <span>{props.notice.status.label}</span>
          </p>
        ) : null}
        <p className="app-notice-toast__message">{props.notice.message}</p>
        {props.notice.threadLink && props.onOpenThread ? (
          <div className="app-notice-toast__thread-link">
            <ThreadChip
              contextMenuClassName="app-notice-toast__thread-menu"
              fallbackLabel={props.notice.detail}
              link={props.notice.threadLink}
              onOpen={props.onOpenThread}
            />
          </div>
        ) : props.notice.detail ? (
          <p className="app-notice-toast__detail">{props.notice.detail}</p>
        ) : null}
      </div>
      <div
        className="app-notice-toast__actions"
      >
        <button
          className="app-notice-toast__icon-button"
          type="button"
          aria-label="Copy notice"
          title="Copy notice"
          onClick={() => {
            void copyText(copyValue, props.desktopApi);
          }}
        >
          <CopyIcon size={14} aria-hidden="true" />
        </button>
        <button
          className="app-notice-toast__icon-button"
          type="button"
          aria-label="Dismiss notice"
          title="Dismiss notice"
          onClick={props.notice.onDismiss ?? props.onDismiss}
        >
          <CloseIcon size={14} aria-hidden="true" />
        </button>
      </div>
      {customActions.length > 0 && !props.navigation ? (
        <div className="app-notice-toast__custom-actions">
          {customActions.map((action) => (
            <button
              key={action.label}
              className={`button button--${action.tone ?? "secondary"}`}
              type="button"
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
      {props.navigation ? (
        <div className="app-notice-toast__footer">
          <span className="app-notice-toast__position">
            {props.navigation.current} of {props.navigation.total}
          </span>
          {hasFooterActions ? (
            <div className="app-notice-toast__custom-actions">
              {customActions.map((action) => (
                <button
                  key={action.label}
                  className={`button button--${action.tone ?? "secondary"}`}
                  type="button"
                  onClick={action.onClick}
                >
                  {action.label}
                </button>
              ))}
              {props.navigation.dismissAll ? (
                <button
                  className="button button--secondary app-notice-toast__dismiss-all"
                  type="button"
                  aria-label={`Dismiss all ${props.navigation.dismissAll.label}`}
                  title={`Dismiss all ${props.navigation.dismissAll.label}`}
                  onClick={props.navigation.dismissAll.onDismiss}
                >
                  Dismiss all
                </button>
              ) : null}
            </div>
          ) : null}
          <nav
            className="app-notice-toast__navigation"
            aria-label="Durable notices"
          >
            <button
              className="app-notice-toast__icon-button"
              type="button"
              aria-label="Previous notice"
              disabled={!props.navigation.onPrevious}
              onClick={props.navigation.onPrevious}
            >
              <ChevronLeftIcon size={14} aria-hidden="true" />
            </button>
            <button
              className="app-notice-toast__icon-button"
              type="button"
              aria-label="Next notice"
              disabled={!props.navigation.onNext}
              onClick={props.navigation.onNext}
            >
              <ChevronRightIcon size={14} aria-hidden="true" />
            </button>
          </nav>
        </div>
      ) : null}
      {autoDismiss ? (
        <span
          className="app-notice-toast__timer"
          aria-hidden="true"
          data-paused={paused ? "true" : undefined}
        />
      ) : null}
    </aside>
  );
}
