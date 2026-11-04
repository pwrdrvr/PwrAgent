import { formatTokenUsageMicrosAsUsd } from "@pwragent/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { BranchIcon } from "../../icons";
import { formatBackendLabel } from "../../lib/backend-label";
import { getDesktopApi } from "../../lib/desktop-api";
import { formatExecutionModeLabel } from "../../lib/execution-mode";
import { useFederationInstanceNameLookup } from "../../lib/federation-display-label";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { useThreadLinks, type ResolvedThreadLink } from "../../lib/thread-links";
import { formatRelativeTime } from "../navigation/thread-time";
import {
  readThreadInfoCost,
  readThreadInfoRow,
  threadInfoFacts,
  threadInfoOwner,
  type ThreadInfoCost,
  type ThreadInfoFacts,
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
 * one exact navigation read; cost is one stored-totals read, cached briefly.
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
    const target = linkRef.current;
    const api = getDesktopApi();
    const windowTarget = readRendererFederationTarget();
    const loaded = threadLinks?.readSummary?.(target);
    const settle = (patch: Partial<ThreadInfo>) => {
      if (current === generation.current) setInfo((previous) => ({ ...previous, ...patch }));
    };
    setInfo({
      ...(loaded ? { facts: threadInfoFacts(loaded) } : {}),
      factsState: loaded ? "ready" : api?.getNavigationQueryPage ? "loading" : "missing",
      cost: api?.readThreadFamilyPricing ? { state: "loading" } : { state: "unavailable" },
    });
    if (!loaded && api?.getNavigationQueryPage) {
      readThreadInfoRow(api, target, windowTarget).then(
        (row) => settle(row ? { facts: threadInfoFacts(row), factsState: "ready" } : { factsState: "missing" }),
        () => settle({ factsState: "missing" }),
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

function formatUsd(micros: number): string {
  return formatTokenUsageMicrosAsUsd(micros);
}

export function ThreadInfoCard(props: {
  link: ResolvedThreadLink;
  label: string;
  info: ThreadInfo;
  now?: number;
}) {
  const { link, info } = props;
  const now = props.now ?? Date.now();
  const instanceNames = useFederationInstanceNameLookup();
  const machine = link.instanceId
    ? instanceNames(link.instanceId, link.instanceLabel ?? link.instanceId).label
    : readRendererFederationTarget() ? undefined : "This machine";
  const facts = info.facts;
  const title = facts?.title?.trim() || props.label;
  const missing = info.factsState === "missing";
  const phase = missing ? "not found"
    : !facts ? undefined
    : facts.archivedAt ? "archived"
    : facts.ownerOffline ? "offline"
    : facts.running ? "running" : "idle";
  const dot = missing || facts?.ownerOffline ? "offline"
    : facts?.archivedAt ? "archived"
    : facts?.running ? "running" : "idle";
  const status = missing
    ? "No connected machine reports this thread. It may be archived, or its machine may be offline."
    : !facts ? undefined
    : facts.ownerOffline ? `${machine ?? "Its machine"} is offline · last known`
    : facts.archivedAt ? "Archived"
    : facts.running ? (facts.subAgentWorking ? "Running · sub-agent working" : "Running")
    : "Idle";
  const model = facts?.model;
  const cost = info.cost;

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
                  {formatUsd(cost.totalMicros)}{cost.partial ? "+" : ""}
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
                <span className="pr-status-card__row-value">{formatUsd(cost.ownMicros)}</span>
              </div>
              <div className="pr-status-card__row">
                <span className="pr-status-card__row-label">Sub-threads</span>
                <span className="pr-status-card__row-value">{formatUsd(cost.totalMicros - cost.ownMicros)}</span>
              </div>
            </>
          ) : (
            <div className="thread-info-card__cost">
              <span className="thread-info-card__cost-total">
                {formatUsd(cost.ownMicros)}{cost.partial ? "+" : ""}
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
