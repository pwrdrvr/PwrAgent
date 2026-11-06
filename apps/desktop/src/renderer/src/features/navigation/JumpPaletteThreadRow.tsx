import {
  useLayoutEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  threadHasExactPrNumberMatch,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { AgentThreadChip } from "./AgentThreadChip";
import { InstanceChip } from "../federation/InstanceGlyph";
import { PrChip } from "../pr-status/PrChip";
import { formatFullTimestamp, formatRelativeTime } from "./thread-time";
import { isThreadActive, isThreadRemoteWorkHere, ThreadRowStatus } from "./ThreadRowStatus";

/**
 * One thread result of the jump palette (⌘K), shared with every picker that
 * searches threads the palette's way. The row is an `option` steered by its
 * field through `aria-activedescendant`; the button is never a tab stop, so
 * typing never leaves the field.
 *
 * Everything after the title sits in `.jump-palette__row-meta`, which is
 * `display: contents` in the palette's one-line row. A narrow host (the
 * to-do card's destination picker) lays it out as a second line instead.
 */
export function JumpPaletteThreadRow(props: {
  thread: NavigationThreadSummary;
  thinkingThreadKeys?: Record<string, boolean>;
  id: string;
  active: boolean;
  /** The query's free text, which puts an exactly matching PR first. */
  query: string;
  onPoint: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onChoose: () => void;
  onOpenPullRequest: (url: string) => void;
}): ReactElement {
  const { thread } = props;
  const description = describeThread(thread);
  const prs = orderPullRequestsForQuery(thread, props.query);
  const exactPrQuery = threadHasExactPrNumberMatch(thread, props.query)
    ? String(Number(props.query.replace(/^#/, "")))
    : "";
  const prStripResetKey = `${exactPrQuery}|${prs
    .map((pr) => pr.url)
    .join("|")}`;
  return (
    <li id={props.id} role="option" aria-selected={props.active}>
      <button
        type="button"
        className={`jump-palette__row${props.active ? " is-active" : ""}`}
        // Not a tab stop: focus stays in the field so typing never breaks,
        // and the active row is published via aria-activedescendant.
        tabIndex={-1}
        onMouseMove={props.onPoint}
        onClick={props.onChoose}
      >
        <span className="jump-palette__row-title">
          {isThreadActive(thread, props.thinkingThreadKeys) ? (
            <ThreadRowStatus status="thinking" remoteWork={isThreadRemoteWorkHere(thread)} />
          ) : null}
          {thread.title}
        </span>
        <span className="jump-palette__row-meta">
          {thread.federation ? (
            <InstanceChip
              icon={thread.federation.celestialIcon}
              instanceId={
                thread.federation.ref.target.scope === "remote"
                  ? thread.federation.ref.target.instanceId
                  : ""
              }
              label={thread.federation.instanceLabel}
            />
          ) : null}
          {thread.agent ? <AgentThreadChip /> : null}
          {prs.length > 0 ? (
            <PullRequestStrip
              prs={prs}
              resetKey={prStripResetKey}
              onOpen={props.onOpenPullRequest}
            />
          ) : null}
          {description.branch ? (
            // Clipped from the LEFT (`direction: rtl` in CSS) so a long
            // `agent/…` prefix gives way and the disambiguating leaf survives.
            <span className="jump-palette__row-branch">{description.branch}</span>
          ) : null}
          {description.directory ? (
            <span className="jump-palette__row-repo">{description.directory}</span>
          ) : null}
          {thread.updatedAt ? <JumpPaletteRowTime timestamp={thread.updatedAt} /> : null}
        </span>
      </button>
    </li>
  );
}

/**
 * The sidebar row's age label, so a match from an hour ago and one from last
 * spring no longer look alike. Hover gives the full date with its year.
 */
export function JumpPaletteRowTime(props: { timestamp: number }): ReactElement {
  return (
    <span
      className="jump-palette__row-time tooltip-target"
      data-tooltip={formatFullTimestamp(props.timestamp)}
    >
      {formatRelativeTime(props.timestamp)}
    </span>
  );
}

type ThreadDescription = {
  branch?: string;
  directory?: string;
};

function PullRequestStrip(props: {
  prs: NonNullable<NavigationThreadSummary["prs"]>;
  resetKey: string;
  onOpen: (url: string) => void;
}): ReactElement {
  const stripRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    if (stripRef.current) {
      stripRef.current.scrollLeft = 0;
    }
  }, [props.resetKey]);

  return (
    <span
      ref={stripRef}
      className="jump-palette__row-prs"
      data-overflow={props.prs.length > 2 ? "true" : undefined}
      aria-label="Pull requests"
      onWheel={scrollPullRequestsHorizontally}
    >
      {props.prs.map((pr) => (
        <PrChip
          key={pr.url}
          pr={pr}
          showRepoPrefix={false}
          onOpen={props.onOpen}
        />
      ))}
    </span>
  );
}

function orderPullRequestsForQuery(
  thread: NavigationThreadSummary,
  query: string,
): NonNullable<NavigationThreadSummary["prs"]> {
  const prs = thread.prs ?? [];
  if (!threadHasExactPrNumberMatch(thread, query)) {
    return prs;
  }
  const number = Number(query.trim().replace(/^#/, ""));
  return [
    ...prs.filter((pr) => pr.number === number),
    ...prs.filter((pr) => pr.number !== number),
  ];
}

function scrollPullRequestsHorizontally(
  event: ReactWheelEvent<HTMLSpanElement>,
): void {
  const strip = event.currentTarget;
  const delta = event.deltaX || event.deltaY;
  if (delta === 0 || strip.scrollWidth <= strip.clientWidth) {
    return;
  }
  const maxScrollLeft = strip.scrollWidth - strip.clientWidth;
  const nextScrollLeft = Math.max(
    0,
    Math.min(maxScrollLeft, strip.scrollLeft + delta),
  );
  if (nextScrollLeft === strip.scrollLeft) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  strip.scrollLeft = nextScrollLeft;
}

function describeThread(
  thread: NavigationThreadSummary,
): ThreadDescription {
  const description: ThreadDescription = {};
  if (thread.gitBranch) {
    description.branch = thread.gitBranch;
  }
  const directory = (thread.linkedDirectories ?? [])[0];
  if (directory?.label) {
    description.directory = directory.label;
  }
  return description;
}
