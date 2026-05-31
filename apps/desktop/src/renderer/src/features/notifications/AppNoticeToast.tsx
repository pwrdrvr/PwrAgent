import { useEffect, useRef, useState } from "react";
import { CloseIcon, CopyIcon } from "../../icons";
import { copyText } from "../../lib/copy-text";
import type { DesktopApi } from "../../lib/desktop-api";

const AUTO_DISMISS_MS = 9_000;

export type AppNoticeToastNotice = {
  id: string;
  title: string;
  message: string;
  detail?: string;
};

export function AppNoticeToast(props: {
  desktopApi?: Pick<DesktopApi, "copyText">;
  notice?: AppNoticeToastNotice;
  onDismiss: () => void;
}) {
  const [paused, setPaused] = useState(false);
  const timeoutRef = useRef<number | undefined>(undefined);
  const onDismissRef = useRef(props.onDismiss);

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
    if (!props.notice || paused) {
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
  }, [paused, props.notice?.id]);

  if (!props.notice) {
    return null;
  }

  const copyValue = [props.notice.title, props.notice.message, props.notice.detail]
    .filter(Boolean)
    .join("\n");

  return (
    <aside
      className="app-notice-toast"
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
        <p className="app-notice-toast__message">{props.notice.message}</p>
        {props.notice.detail ? (
          <p className="app-notice-toast__detail">{props.notice.detail}</p>
        ) : null}
      </div>
      <div className="app-notice-toast__actions">
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
          onClick={props.onDismiss}
        >
          <CloseIcon size={14} aria-hidden="true" />
        </button>
      </div>
      <span
        className="app-notice-toast__timer"
        aria-hidden="true"
        data-paused={paused ? "true" : undefined}
      />
    </aside>
  );
}
