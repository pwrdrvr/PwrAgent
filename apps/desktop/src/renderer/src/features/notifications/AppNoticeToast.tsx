import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
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

/**
 * Whether the pointer is over the region a card holds its size for. The
 * stack provides it, so a held card is released only when the pointer leaves
 * every notice: releasing it as the pointer crossed onto a neighbour would
 * move that neighbour out from under it. A card outside a stack uses its own
 * hover.
 */
export const AppNoticeHoverRegion = createContext<boolean | undefined>(
  undefined,
);

type CardSize = { width: number; height: number };

export type AppNoticeToastNotice = {
  actions?: readonly {
    label: string;
    onClick: () => void;
    tone?: "primary" | "secondary";
    /** Set while the action's own work runs, so a second click cannot repeat it. */
    disabled?: boolean;
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
  /** Optional notice-specific dismissal, including any durable disposition. */
  onDismiss?: () => void;
  /**
   * Names the close button when closing does more than hide the notice, as
   * when it cancels the update download the notice reports. The button
   * itself stays the card's own.
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
  /**
   * Work in flight with a measurable extent, drawn as a bar under the
   * message: determinate with `percent`, a sweep without it. `meter` is the
   * byte count or rate beside it. The message, bar and meter change every
   * tick, so they opt out of the card's live region; the title announces.
   */
  progress?: {
    label: string;
    percent?: number;
    meter?: string;
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
  /**
   * Lays the notice out without showing it: hidden, inert and out of the
   * accessibility tree. A card that shares its grid cell takes the larger of
   * the two sizes (AppNoticeStack.tsx).
   */
  sizer?: boolean;
}) {
  const sizer = props.sizer === true;
  const [paused, setPaused] = useState(false);
  const [suppressionSaving, setSuppressionSaving] = useState(false);
  const [suppressionError, setSuppressionError] = useState(false);
  const timeoutRef = useRef<number | undefined>(undefined);
  const onDismissRef = useRef(props.onDismiss);
  const noticeId = props.notice?.id;
  const noticePresent = props.notice !== undefined;
  const autoDismiss = !sizer && props.notice?.autoDismiss !== false;
  const regionHovered = useContext(AppNoticeHoverRegion);
  const [selfHovered, setSelfHovered] = useState(false);
  const hovered = regionHovered ?? selfHovered;
  const hoveredRef = useRef(hovered);
  hoveredRef.current = hovered;
  const sizeRef = useRef<CardSize | undefined>(undefined);
  const observerRef = useRef<ResizeObserver | undefined>(undefined);
  const shownIdRef = useRef(noticeId);
  const [held, setHeld] = useState<CardSize>();

  // The card's last laid-out size, read without forcing a layout of its own.
  const observeCard = useCallback((card: HTMLElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = undefined;
    if (!card || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.borderBoxSize?.[0];
      sizeRef.current = box
        ? { width: box.inlineSize, height: box.blockSize }
        : { width: card.offsetWidth, height: card.offsetHeight };
    });
    observer.observe(card);
    observerRef.current = observer;
  }, []);

  // One card shows one notice after another: the next durable notice when
  // this one closes, the page Previous or Next turns to, the update offer
  // when its download lands. The stack is anchored at its bottom and the
  // close button sits top-right, so a next notice of another size would
  // move that button out from under a pointer about to click it again.
  // While the pointer stays, the card never shrinks below the notice it
  // replaced, as a browser tab strip holds its tabs through a run of closes.
  // It still grows for a larger notice, so nothing is ever clipped. Runs
  // before paint, so the next notice never draws at its own size first.
  useLayoutEffect(() => {
    const previousId = shownIdRef.current;
    shownIdRef.current = noticeId;
    if (noticeId === undefined) {
      setHeld(undefined);
      return;
    }
    if (previousId === undefined || previousId === noticeId) return;
    const size = sizeRef.current;
    if (hoveredRef.current && size) setHeld(size);
  }, [noticeId]);

  useEffect(() => {
    if (!hovered) setHeld(undefined);
  }, [hovered]);

  useEffect(() => {
    onDismissRef.current = props.onDismiss;
  }, [props.onDismiss]);

  useEffect(() => {
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = undefined;
    }
    setPaused(false);
    setSuppressionSaving(false);
    setSuppressionError(false);
  }, [props.notice?.id]);

  useEffect(() => {
    if (!noticePresent || !autoDismiss || paused || suppressionSaving) {
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
  }, [autoDismiss, noticeId, noticePresent, paused, suppressionSaving]);

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
  // One dot carries the state: a status when the notice reports one, the
  // tone otherwise. The card itself stays neutral.
  const dotState = props.notice.status?.state === "progress"
    || (props.notice.progress && !props.notice.status)
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
  const progress = props.notice.progress;

  return (
    <aside
      ref={sizer ? undefined : observeCard}
      className={sizer ? "app-notice-toast app-notice-toast--sizer" : "app-notice-toast"}
      data-held={held ? "true" : undefined}
      data-navigable={props.navigation && !sizer ? "true" : undefined}
      // The stack holds several notices at once — a durable backend warning
      // sits here for the whole run on a machine with no agent installed — so
      // a spec that wants one of them needs to say which. See "E2E Locator
      // Hygiene Around Global Chrome" in apps/desktop/AGENTS.md.
      data-notice-id={sizer ? undefined : props.notice.id}
      data-tone={props.notice.tone ?? "neutral"}
      role={sizer ? undefined : "status"}
      aria-live={sizer ? undefined : "polite"}
      aria-hidden={sizer ? true : undefined}
      inert={sizer}
      style={held
        ? { minWidth: held.width, minHeight: held.height }
        : undefined}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onPointerEnter={() => setSelfHovered(true)}
      onPointerLeave={() => setSelfHovered(false)}
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
          {props.navigation?.dismissAll ? (
            <button
              className="app-notice-toast__dismiss-all"
              type="button"
              aria-label={`Dismiss all ${props.navigation.dismissAll.label}`}
              title={`Dismiss all ${props.navigation.dismissAll.label}`}
              onClick={props.navigation.dismissAll.onDismiss}
            >
              Dismiss all
            </button>
          ) : null}
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
            onClick={props.notice.onDismiss ?? props.onDismiss}
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
        <p
          className="app-notice-toast__message"
          aria-live={progress ? "off" : undefined}
        >
          {props.notice.message}
        </p>
        {progress ? (
          <>
            <span
              className={progress.percent === undefined
                ? "app-notice-toast__track app-notice-toast__track--indeterminate"
                : "app-notice-toast__track"}
              role="progressbar"
              aria-live="off"
              aria-label={progress.label}
              aria-valuemin={progress.percent === undefined ? undefined : 0}
              aria-valuemax={progress.percent === undefined ? undefined : 100}
              aria-valuenow={progress.percent}
            >
              <i
                style={progress.percent === undefined
                  ? undefined
                  : { width: `${progress.percent}%` }}
              />
            </span>
            {progress.meter ? (
              <p className="app-notice-toast__meter" aria-live="off">
                {progress.meter}
              </p>
            ) : null}
          </>
        ) : null}
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
        {props.notice.skillQuestionsWarning && props.onSuppressSkillQuestionsWarning ? (
          <>
            <label className="composer__checkbox app-notice-toast__suppress">
              <input
                type="checkbox"
                checked={suppressionSaving}
                disabled={suppressionSaving}
                onChange={() => {
                  setSuppressionSaving(true);
                  setSuppressionError(false);
                  void props.onSuppressSkillQuestionsWarning?.().then(
                    (saved) => {
                      setSuppressionSaving(false);
                      if (saved) props.onDismiss();
                      else setSuppressionError(true);
                    },
                    () => {
                      setSuppressionSaving(false);
                      setSuppressionError(true);
                    },
                  );
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
          {customActions.length > 0 ? (
            <div className="app-notice-toast__custom-actions">
              {customActions.map((action) => (
                <button
                  key={action.label}
                  className={`button button--${action.tone ?? "secondary"} app-notice-toast__button`}
                  type="button"
                  disabled={action.disabled}
                  onClick={action.onClick}
                >
                  {action.label}
                </button>
              ))}
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
