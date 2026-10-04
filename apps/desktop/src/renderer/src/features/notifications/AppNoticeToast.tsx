import { useEffect, useRef, useState, type ReactNode } from "react";
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
  /** Offers a profile-scoped dismissal for this one Codex development warning. */
  skillQuestionsWarning?: boolean;
  /** Offers a profile-scoped dismissal saved under this Codex warning id. */
  warningSuppressionId?: string;
  /** Optional notice-specific dismissal, including any durable disposition. */
  onDismiss?: () => void;
  /**
   * Names the close button when closing does more than hide the notice, as
   * when it ends a live session. The button itself stays the card's own.
   */
  dismissLabel?: string;
  detail?: string;
  /** Interactive controls supplied by an in-window notice producer. */
  body?: ReactNode;
  /**
   * Machine state (a path, a host, a session id) as label/value rows, set in
   * mono. `detail` stays prose: the card cannot tell a path from a sentence.
   */
  facts?: readonly { label: string; value: string }[];
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
  children?: ReactNode;
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
  onSuppressSkillQuestionsWarning?: () => Promise<boolean>;
  onSuppressCodexWarning?: (id: string) => Promise<boolean>;
}) {
  const [paused, setPaused] = useState(false);
  // The checkbox records a choice; closing the toast applies it.
  const [suppressOnDismiss, setSuppressOnDismiss] = useState(false);
  const [suppressionSaving, setSuppressionSaving] = useState(false);
  const [suppressionError, setSuppressionError] = useState(false);
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
    setSuppressOnDismiss(false);
    setSuppressionSaving(false);
    setSuppressionError(false);
  }, [props.notice?.id]);

  useEffect(() => {
    // A checked "Don't show again" waits for the operator to close the toast;
    // the timer must neither drop that choice nor apply it unasked.
    if (
      !noticePresent
      || !autoDismiss
      || paused
      || suppressOnDismiss
      || suppressionSaving
    ) {
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
  }, [autoDismiss, noticeId, noticePresent, paused, suppressOnDismiss, suppressionSaving]);

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
      ...(props.notice.facts ?? []).map(
        (fact) => `${fact.label}: ${fact.value}`,
      ),
    ]
      .filter(Boolean)
      .join("\n");
  const customActions = props.notice.actions ?? [];
  const hasFooterActions = customActions.length > 0
    || props.navigation?.dismissAll !== undefined;
  // One dot carries the state: a status when the notice reports one, the
  // tone otherwise. The card itself stays neutral.
  const dotState = props.notice.status?.state === "progress"
    ? "warning status-dot--blink"
    : props.notice.status?.state === "success"
      ? "ok"
      : props.notice.status?.state === "error"
        ? "error"
        : props.notice.tone === "warning"
          ? "warning"
          : props.notice.tone === "success"
            ? "ok"
            : props.notice.tone === "error"
              ? "error"
              : "neutral";
  const facts = props.notice.facts ?? [];
  const dismissNotice = props.notice.onDismiss ?? props.onDismiss;
  const { warningSuppressionId } = props.notice;
  const onSuppressCodexWarning = props.onSuppressCodexWarning;
  const suppressWarning = props.notice.skillQuestionsWarning
    ? props.onSuppressSkillQuestionsWarning
    : warningSuppressionId && onSuppressCodexWarning
      ? () => onSuppressCodexWarning(warningSuppressionId)
      : undefined;
  const closeNotice = (): void => {
    if (!suppressOnDismiss || !suppressWarning) {
      dismissNotice();
      return;
    }
    setSuppressionSaving(true);
    setSuppressionError(false);
    void suppressWarning().then(
      (saved) => {
        setSuppressionSaving(false);
        if (saved) dismissNotice();
        else setSuppressionError(true);
      },
      () => {
        setSuppressionSaving(false);
        setSuppressionError(true);
      },
    );
  };

  return (
    <aside
      className="app-notice-toast"
      data-navigable={props.navigation ? "true" : undefined}
      // The stack holds several notices at once — a durable backend warning
      // sits here for the whole run on a machine with no agent installed — so
      // a spec that wants one of them needs to say which. See "E2E Locator
      // Hygiene Around Global Chrome" in apps/desktop/AGENTS.md.
      data-notice-id={props.notice.id}
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
      <div className="app-notice-toast__head">
        <span
          className={`status-dot status-dot--${dotState} app-notice-toast__dot`}
          aria-hidden="true"
        />
        <p className="app-notice-toast__title">{props.notice.title}</p>
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
            <CopyIcon size={13} aria-hidden="true" />
          </button>
          <button
            className="app-notice-toast__icon-button"
            type="button"
            aria-label={props.notice.dismissLabel ?? "Dismiss notice"}
            title={props.notice.dismissLabel ?? "Dismiss notice"}
            disabled={suppressionSaving}
            onClick={closeNotice}
          >
            <CloseIcon size={13} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="app-notice-toast__content">
        {props.notice.status ? (
          <p
            className="app-notice-toast__status"
            data-state={props.notice.status.state}
          >
            {props.notice.status.label}
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
        {facts.length > 0 ? (
          <dl className="app-notice-toast__facts">
            {facts.map((fact) => (
              <div key={fact.label} className="app-notice-toast__fact">
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {suppressWarning ? (
          <>
            <label className="composer__checkbox app-notice-toast__suppress">
              <input
                type="checkbox"
                checked={suppressOnDismiss}
                disabled={suppressionSaving}
                onChange={(event) => {
                  setSuppressOnDismiss(event.currentTarget.checked);
                  setSuppressionError(false);
                }}
              />
              Don't show again
            </label>
            {suppressionError ? (
              <p className="app-notice-toast__suppression-error">
                Could not save this preference.
              </p>
            ) : null}
          </>
        ) : null}
      </div>
      {props.notice.body || props.children ? (
        <div className="app-notice-toast__body">{props.notice.body}{props.children}</div>
      ) : null}
      {props.navigation || customActions.length > 0 ? (
        <div className="app-notice-toast__footer">
          {props.navigation ? (
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
                <ChevronLeftIcon size={13} aria-hidden="true" />
              </button>
              <span className="app-notice-toast__position">
                {props.navigation.current} of {props.navigation.total}
              </span>
              <button
                className="app-notice-toast__icon-button"
                type="button"
                aria-label="Next notice"
                disabled={!props.navigation.onNext}
                onClick={props.navigation.onNext}
              >
                <ChevronRightIcon size={13} aria-hidden="true" />
              </button>
            </nav>
          ) : null}
          {hasFooterActions ? (
            <div className="app-notice-toast__custom-actions">
              {customActions.map((action) => (
                <button
                  key={action.label}
                  className={`button button--${action.tone ?? "secondary"} app-notice-toast__button`}
                  type="button"
                  onClick={action.onClick}
                >
                  {action.label}
                </button>
              ))}
              {props.navigation?.dismissAll ? (
                <button
                  className="button app-notice-toast__button app-notice-toast__dismiss-all"
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
