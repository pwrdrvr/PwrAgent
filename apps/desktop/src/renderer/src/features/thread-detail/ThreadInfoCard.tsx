import { formatTokenUsageMicrosAsUsd } from "@pwragent/shared/token-usage-pricing";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ActivityIcon,
  BranchIcon,
  CommitIcon,
  CopyIcon,
  FolderIcon,
  PricingIcon,
  PullRequestIcon,
  ServerIcon,
  WorktreeIcon,
} from "../../icons";
import { formatBackendLabel } from "../../lib/backend-label";
import { getDesktopApi } from "../../lib/desktop-api";
import { formatExecutionModeLabel } from "../../lib/execution-mode";
import { useFederationInstanceNameLookup } from "../../lib/federation-display-label";
import { readRendererFederationLabel, readRendererFederationTarget } from "../../lib/federation-window";
import {
  threadLinkNamesThisMachine,
  threadLinkReadScope,
  useThreadLinks,
  type ResolvedThreadLink,
} from "../../lib/thread-links";
import { formatRelativeTime } from "../navigation/thread-time";
import { prStatusLabel, resolveChipState, resolveLifecycleState } from "../pr-status/pr-chip-state";
import {
  formatCompactTokens,
  readThreadInfoCost,
  readThreadInfoRow,
  threadInfoFacts,
  threadInfoOwner,
  type ThreadInfoCost,
  type ThreadInfoFacts,
  type ThreadInfoRowFacts,
} from "./thread-info";

export type ThreadInfo = {
  facts?: ThreadInfoFacts;
  /** `missing` once no loaded row and no owner row names the thread. */
  factsState: "idle" | "loading" | "ready" | "missing";
  cost: ThreadInfoCost | { state: "idle" };
};

const IDLE: ThreadInfo = { factsState: "idle", cost: { state: "idle" } };

/**
 * A thread chip's hover card data, read when the card opens, never per
 * render. A loaded row answers at once; a thread outside the loaded rows is
 * one exact navigation read, shared with the chip's encounter cache; cost
 * is one stored-totals read, cached briefly.
 */
export function useThreadInfo(link: ResolvedThreadLink): {
  info: ThreadInfo;
  load: () => void;
} {
  const threadLinks = useThreadLinks();
  const [info, setInfo] = useState<ThreadInfo>(IDLE);
  const generation = useRef(0);
  const linkRef = useRef(link);
  linkRef.current = link;
  const identity = `${link.instanceId ?? ""}:${link.backend}:${link.threadId}`;
  useEffect(() => {
    generation.current += 1;
    setInfo(IDLE);
  }, [identity]);
  useEffect(() => () => { generation.current += 1; }, []);

  const load = useCallback(() => {
    const current = ++generation.current;
    const { link: target, windowTarget } = threadLinkReadScope(
      linkRef.current,
      threadLinks?.localInstanceId,
    );
    const api = getDesktopApi();
    const loaded = threadLinks?.readSummary?.(target);
    const settle = (patch: Partial<ThreadInfo>) => {
      if (current === generation.current) setInfo((previous) => ({ ...previous, ...patch }));
    };
    setInfo({
      ...(loaded ? { facts: threadInfoFacts(loaded) } : {}),
      // Without a read, or when it fails, the thread is unknown, not missing.
      factsState: loaded ? "ready" : api?.getNavigationQueryPage ? "loading" : "ready",
      cost: api?.readThreadFamilyPricing ? { state: "loading" } : { state: "unavailable" },
    });
    if (!loaded && api?.getNavigationQueryPage) {
      readThreadInfoRow(api, target, windowTarget).then(
        (row) => {
          if (row) void threadLinks?.hydrate?.(linkRef.current).catch(() => {});
          settle(row ? { facts: threadInfoFacts(row), factsState: "ready" } : { factsState: "missing" });
        },
        () => settle({ factsState: "ready" }),
      );
    }
    if (api?.readThreadFamilyPricing) {
      void readThreadInfoCost(api, target, threadInfoOwner(target, windowTarget))
        .then((cost) => settle({ cost }));
    }
  }, [threadLinks]);

  return { info, load };
}

function sinceLabel(timestamp: number, now: number): string {
  const label = formatRelativeTime(timestamp);
  if (label === "now" || now - timestamp < 60_000) return "now";
  // Past a week the label is a date ("Aug 16"), which takes no "ago".
  return /^\d/.test(label) ? `${label} ago` : label;
}

export function ThreadInfoCard(props: {
  link: ResolvedThreadLink;
  label: string;
  info: ThreadInfo;
  now?: number;
  /**
   * A sidebar row's card: the row's facts as icon rows in place of the
   * chip card's sections, then `actions`. The branch and PR rows are
   * pointer targets when their handlers are given.
   */
  row?: ThreadInfoRowFacts;
  actions?: ReactNode;
  onCopyBranch?: () => void;
  onOpenPullRequest?: () => void;
}) {
  const { link, info } = props;
  const now = props.now ?? Date.now();
  const instanceNames = useFederationInstanceNameLookup();
  const localInstanceId = useThreadLinks()?.localInstanceId;
  const machine = threadLinkNamesThisMachine(link, localInstanceId)
    ? "This machine"
    : link.instanceId
    ? instanceNames(link.instanceId, link.instanceLabel ?? link.instanceId).label
    : readRendererFederationTarget() ? readRendererFederationLabel() : "This machine";
  const facts = info.facts;
  const title = facts?.title?.trim() || props.label;
  const missing = info.factsState === "missing";
  const phase = missing ? "not found"
    : !facts ? undefined
    : facts.archived ? "archived"
    : facts.ownerOffline ? "offline"
    : facts.running ? "running" : "idle";
  const dot = missing || facts?.ownerOffline ? "offline"
    : facts?.archived ? "archived"
    : facts?.running ? "running" : "idle";
  const status = missing
    ? `Thread not found on ${machine === "This machine" ? "this machine" : machine ?? "its owning machine"}.`
    : !facts ? undefined
    : facts.ownerOffline ? `${machine ?? "Its machine"} is offline · last known`
    : facts.archived ? "Archived"
    : facts.running ? (facts.subAgentWorking ? "Running · sub-agent working" : "Running")
    : "Idle";
  const model = facts?.model;
  const cost = info.cost;

  if (props.row) {
    return (
      <ThreadInfoRowLayout
        row={props.row}
        title={title}
        dot={dot}
        phase={phase}
        since={facts?.updatedAt
          ? facts.running && !facts.ownerOffline ? "now" : sinceLabel(facts.updatedAt, now)
          : undefined}
        subAgentWorking={facts?.subAgentWorking === true && !facts.ownerOffline}
        cost={cost}
        actions={props.actions}
        onCopyBranch={props.onCopyBranch}
        onOpenPullRequest={props.onOpenPullRequest}
      />
    );
  }

  return (
    <>
      <div className="pr-status-card__header">
        <span className="pr-status-card__eyebrow">Thread</span>
        {phase ? <span className="pr-status-card__phase">{phase}</span> : null}
      </div>
      {missing ? null : <div className="pr-status-card__title">{title}</div>}
      {machine ? <div className="thread-info-card__machine">{machine}</div> : null}
      <div className="thread-info-card__id">{link.threadId}</div>
      {facts?.gitBranch ? (
        <div className="pr-status-card__branch">
          <BranchIcon aria-hidden="true" className="pr-status-card__branch-icon" size={11} />
          <span className="thread-info-card__branch">{facts.gitBranch}</span>
        </div>
      ) : null}
      {status ? (
        <div className="pr-status-card__status">
          <span aria-hidden="true" className={`thread-info-card__dot thread-info-card__dot--${dot}`} />
          <span>{status}</span>
        </div>
      ) : info.factsState === "loading" ? (
        <div className="pr-status-card__status" aria-busy="true">
          <span className="thread-info-card__skeleton" />
        </div>
      ) : null}
      {missing ? null : (
        <div className="pr-status-card__section">
          <span className="pr-status-card__section-title">Agent</span>
          <div className="pr-status-card__row">
            <span className="pr-status-card__row-label">Provider</span>
            <span className="pr-status-card__row-value">{formatBackendLabel(link.backend)}</span>
          </div>
          {model ? (
            <div className="pr-status-card__row">
              <span className="pr-status-card__row-label">Model</span>
              <span className="pr-status-card__row-value thread-info-card__value">
                {model}
                {facts?.reasoningEffort ? <span className="thread-info-card__aside"> · {facts.reasoningEffort}</span> : null}
              </span>
            </div>
          ) : null}
          {facts?.executionMode ? (
            <div className="pr-status-card__row">
              <span className="pr-status-card__row-label">Access</span>
              <span className="pr-status-card__row-value">{formatExecutionModeLabel(facts.executionMode)}</span>
            </div>
          ) : null}
        </div>
      )}
      {missing || cost.state === "idle" ? null : (
        <div className="pr-status-card__section">
          <span className="pr-status-card__section-title">Cost</span>
          {cost.state === "loading" ? (
            <div className="thread-info-card__cost" aria-busy="true">
              <span className="thread-info-card__skeleton thread-info-card__skeleton--big" />
            </div>
          ) : cost.state === "unavailable" ? (
            <div className="thread-info-card__note">
              {facts?.ownerOffline ? `Unavailable while ${machine ?? "its machine"} is offline.` : "Not available."}
            </div>
          ) : cost.subThreadCount > 0 ? (
            <>
              <div className="thread-info-card__cost">
                <span className="thread-info-card__cost-total">
                  {formatTokenUsageMicrosAsUsd(cost.totalMicros)}{cost.partial ? "+" : ""}
                </span>
                <span className="thread-info-card__cost-caption">
                  with {cost.subThreadCount} sub-thread{cost.subThreadCount === 1 ? "" : "s"}
                </span>
              </div>
              {cost.totalMicros > 0 ? (
                <div aria-hidden="true" className="thread-info-card__share">
                  <span className="thread-info-card__share-self"
                    style={{ width: `${(cost.ownMicros / cost.totalMicros) * 100}%` }} />
                  <span className="thread-info-card__share-sub" />
                </div>
              ) : null}
              <div className="pr-status-card__row">
                <span className="pr-status-card__row-label">This thread</span>
                <span className="pr-status-card__row-value">{formatTokenUsageMicrosAsUsd(cost.ownMicros)}</span>
              </div>
              <div className="pr-status-card__row">
                <span className="pr-status-card__row-label">Sub-threads</span>
                <span className="pr-status-card__row-value">{formatTokenUsageMicrosAsUsd(cost.totalMicros - cost.ownMicros)}</span>
              </div>
            </>
          ) : (
            <div className="thread-info-card__cost">
              <span className="thread-info-card__cost-total">
                {formatTokenUsageMicrosAsUsd(cost.ownMicros)}{cost.partial ? "+" : ""}
              </span>
              <span className="thread-info-card__cost-caption">this thread</span>
            </div>
          )}
        </div>
      )}
      {facts?.createdAt || facts?.updatedAt ? (
        <div className="pr-status-card__section">
          <span className="pr-status-card__section-title">Timeline</span>
          {facts.createdAt ? (
            <div className="pr-status-card__row">
              <span className="pr-status-card__row-label">Started</span>
              <span className="pr-status-card__row-value">{sinceLabel(facts.createdAt, now)}</span>
            </div>
          ) : null}
          {facts.updatedAt ? (
            <div className="pr-status-card__row">
              <span className="pr-status-card__row-label">Last activity</span>
              <span className="pr-status-card__row-value">
                {facts.running && !facts.ownerOffline ? "now" : sinceLabel(facts.updatedAt, now)}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function ThreadInfoRowLayout(props: {
  row: ThreadInfoRowFacts;
  title: string;
  dot: string;
  phase?: string;
  since?: string;
  subAgentWorking: boolean;
  cost: ThreadInfo["cost"];
  actions?: ReactNode;
  onCopyBranch?: () => void;
  onOpenPullRequest?: () => void;
}) {
  const { row, cost } = props;
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  const [primary, ...attached] = row.folders;
  const phase = props.phase ? props.phase[0].toUpperCase() + props.phase.slice(1) : undefined;
  const eyebrow = [phase, row.backendLabel, props.subAgentWorking ? "sub-agent working" : undefined]
    .filter(Boolean)
    .join(" · ");
  const pr = row.pr;
  const prState = pr ? resolveLifecycleState(pr.pr) : undefined;
  const BranchGlyph = row.branch?.kind === "worktree" ? WorktreeIcon : BranchIcon;
  // This thread's own spend beside its model; the chip card has the family.
  const costLabel = cost.state === "ready"
    ? `${formatTokenUsageMicrosAsUsd(cost.ownMicros)}${cost.partial ? "+" : ""}`
    : undefined;
  const contextPercent = row.context
    ? Math.min(100, Math.max(0, row.context.totalTokens / row.context.modelContextWindow * 100))
    : 0;
  return (
    <>
      <div className="pr-status-card__header">
        <span className="thread-info-card__eyebrow">
          <span aria-hidden="true" className={`thread-info-card__dot thread-info-card__dot--${props.dot}`} />
          <span className="thread-info-card__eyebrow-text">{eyebrow}</span>
        </span>
        {props.since ? <span className="pr-status-card__phase">{props.since}</span> : null}
      </div>
      <div className="pr-status-card__title">{props.title}</div>
      <div className="thread-info-card__facts">
        {primary ? (
          <div className="thread-info-card__fact">
            <FolderIcon aria-hidden="true" size={13} />
            <span className="thread-info-card__fact-value">
              {primary.label}
              {attached.length ? <span className="thread-info-card__aside"> + {attached[0].label}</span> : null}
            </span>
            <span className="thread-info-card__fact-meta">
              {row.folders.length === 1 ? "1 folder" : `${row.folders.length} folders`}
            </span>
          </div>
        ) : null}
        <div className="thread-info-card__fact">
          <ServerIcon aria-hidden="true" size={13} />
          <span className="thread-info-card__fact-value">{row.machine.label}</span>
          <span className="thread-info-card__fact-meta">{row.machine.local ? "this machine" : "peer"}</span>
        </div>
        {row.branch ? (
          <FactTarget
            label={`Copy branch name ${row.branch.name}`}
            onActivate={props.onCopyBranch ? () => {
              props.onCopyBranch?.();
              setCopied(true);
              window.clearTimeout(copiedTimer.current);
              copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
            } : undefined}
          >
            <BranchGlyph aria-hidden="true" size={13} />
            <span className="thread-info-card__fact-value thread-info-card__fact-value--mono">{row.branch.name}</span>
            <span className="thread-info-card__fact-meta">
              {copied ? "Copied" : (
                <>
                  {row.branch.kind}
                  {/* Shown on hover or focus: the row copies the name. */}
                  {props.onCopyBranch ? (
                    <CopyIcon aria-hidden="true" className="thread-info-card__copy-hint" size={11} />
                  ) : null}
                </>
              )}
            </span>
          </FactTarget>
        ) : null}
        {row.ahead || row.dirty ? (
          <div className="thread-info-card__fact">
            <CommitIcon aria-hidden="true" size={13} />
            <span className="thread-info-card__fact-value">
              {row.ahead
                ? `${row.ahead.count} ahead${row.ahead.base ? ` of ${row.ahead.base}` : ""}`
                : "Uncommitted changes"}
            </span>
            {row.dirty ? (
              <span className="thread-info-card__fact-meta">
                <span className="thread-info-card__add">+{row.dirty.additions.toLocaleString()}</span>
                {" "}
                <span className="thread-info-card__del">−{row.dirty.deletions.toLocaleString()}</span>
              </span>
            ) : <span />}
          </div>
        ) : null}
        {pr ? (
          <FactTarget
            label={pr.more > 0
              ? `Show ${pr.more + 1} pull requests, #${pr.pr.number} leading`
              : `Open pull request #${pr.pr.number}`}
            onActivate={props.onOpenPullRequest}
          >
            <PullRequestIcon aria-hidden="true" size={13} />
            <span className="thread-info-card__fact-value">
              <span
                aria-hidden="true"
                className={`thread-info-card__pr-dot pr-status-card__dot--${resolveChipState(pr.pr)}`}
              />
              #{pr.pr.number}
              {pr.more > 0 ? (
                <span className="thread-info-card__aside"> +{pr.more}</span>
              ) : ` · ${prStatusLabel(pr.pr)}`}
            </span>
            <span className="thread-info-card__fact-meta">{prState}</span>
          </FactTarget>
        ) : null}
        {row.model ? (
          <div className="thread-info-card__fact">
            <PricingIcon aria-hidden="true" size={13} />
            <span className="thread-info-card__fact-value">{row.model}</span>
            <span className="thread-info-card__fact-meta">
              {cost.state === "loading" ? <span className="thread-info-card__skeleton thread-info-card__skeleton--small" /> : costLabel}
            </span>
          </div>
        ) : null}
        {row.context ? (
          <div className="thread-info-card__fact">
            <ActivityIcon aria-hidden="true" size={13} />
            <span className="thread-info-card__fact-value">
              Context {formatCompactTokens(row.context.totalTokens)} of {formatCompactTokens(row.context.modelContextWindow)}
              <span aria-hidden="true" className="thread-info-card__share thread-info-card__context">
                <span
                  className="thread-info-card__context-used"
                  style={{ width: `${contextPercent}%` }}
                />
              </span>
            </span>
            <span className="thread-info-card__fact-meta">{Math.round(contextPercent)}%</span>
          </div>
        ) : null}
      </div>
      {props.actions}
    </>
  );
}

/** A fact row that is also a pointer shortcut, like the card's actions. */
function FactTarget(props: { label: string; onActivate?: () => void; children: ReactNode }) {
  if (!props.onActivate) return <div className="thread-info-card__fact">{props.children}</div>;
  return (
    <button
      aria-label={props.label}
      className="thread-info-card__fact thread-info-card__fact--target"
      tabIndex={-1}
      type="button"
      onClick={props.onActivate}
    >
      {props.children}
    </button>
  );
}
