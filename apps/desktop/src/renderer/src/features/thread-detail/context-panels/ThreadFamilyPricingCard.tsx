import {
  formatTokenUsageMicrosAsUsd,
  type AppServerBackendKind,
  type ReadThreadFamilyPricingResponse,
  type ThreadFamilyPricingMember,
} from "@pwragent/shared";
import { memo, useEffect, useState } from "react";
import type { DesktopApi } from "../../../lib/desktop-api";
import { useThreadLinks } from "../../../lib/thread-links";
import { formatTimestamp } from "./context-rail-shared";

type ThreadFamilyPricingCardProps = {
  desktopApi?: Pick<DesktopApi, "readThreadFamilyPricing">;
  backend: AppServerBackendKind;
  threadId: string;
  /** Ordinary sub-threads directly under this one; zero renders nothing. */
  subThreadCount: number;
};

/** Sub-threads past this many share the neutral swatch and fold into one row. */
const NAMED_SUB_THREADS = 4;

type FamilyRead =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "ready"; threadKey: string; family: ReadThreadFamilyPricingResponse };

/**
 * What a thread and every sub-thread under it cost, from each thread's stored
 * running total. It is read when the Pricing tab opens and on Refresh, never
 * per streamed event: a running sub-thread keeps spending after the read, and
 * the card says so rather than re-reading underneath the operator.
 */
export const ThreadFamilyPricingCard = memo(function ThreadFamilyPricingCard(props: ThreadFamilyPricingCardProps) {
  const read = props.desktopApi?.readThreadFamilyPricing;
  const enabled = Boolean(read) && props.subThreadCount > 0;
  const [result, setResult] = useState<FamilyRead>({ state: "loading" });
  const [refreshes, setRefreshes] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const threadLinks = useThreadLinks();

  const threadKey = JSON.stringify([props.backend, props.threadId]);
  useEffect(() => {
    if (!enabled || !read) return;
    let current = true;
    // Refresh keeps this thread's last totals on screen until the new read lands.
    setResult((previous) => previous.state === "ready" && previous.threadKey === threadKey
      ? previous : { state: "loading" });
    read({ backend: props.backend, threadId: props.threadId }).then(
      (family) => { if (current) setResult({ state: "ready", threadKey, family }); },
      () => { if (current) setResult({ state: "failed" }); },
    );
    return () => { current = false; };
  }, [enabled, read, props.backend, props.threadId, threadKey, refreshes]);

  useEffect(() => { setExpanded(false); }, [threadKey]);

  if (!enabled) return null;

  if (result.state === "loading" || (result.state === "ready" && result.threadKey !== threadKey)) {
    return (
      <div className="rail-summary-card thread-family-pricing" aria-busy="true">
        <div className="rail-summary-card__header">
          <span className="rail-summary-card__eyebrow">Thread + sub-threads</span>
          <span className="rail-summary-card__meta">Adding up sub-threads…</span>
        </div>
        <span className="thread-family-pricing__placeholder thread-family-pricing__placeholder--primary" />
        <span className="thread-family-pricing__placeholder thread-family-pricing__placeholder--bar" />
      </div>
    );
  }

  if (result.state === "failed") {
    return (
      <div className="rail-summary-card thread-family-pricing">
        <div className="rail-summary-card__header">
          <span className="rail-summary-card__eyebrow">Thread + sub-threads</span>
          <button className="thread-family-pricing__refresh" type="button" onClick={() => setRefreshes((count) => count + 1)}>
            Try again
          </button>
        </div>
        <div className="thread-family-pricing__warning">Sub-thread totals could not be read.</div>
      </div>
    );
  }

  const members = result.family.members;
  const self = members.find((member) => member.self);
  const subThreads = members.filter((member) => !member.self);
  // A sub-thread can be archived or removed between the sidebar count and
  // the read; with none left there is no family to total.
  if (!self || subThreads.length === 0) return null;

  const totalMicros = members.reduce((sum, member) => sum + member.totalCostMicros, 0);
  const subThreadMicros = totalMicros - self.totalCostMicros;
  const unpriced = members.filter((member) => member.unpricedUsageLineCount > 0);
  const unpricedRows = unpriced.reduce((sum, member) => sum + member.unpricedUsageLineCount, 0);
  const running = members.filter((member) => member.active).length;
  const named = subThreads.slice(0, NAMED_SUB_THREADS);
  const folded = subThreads.slice(NAMED_SUB_THREADS);
  const foldedMicros = folded.reduce((sum, member) => sum + member.totalCostMicros, 0);
  const listed = expanded ? subThreads : named;
  const share = (micros: number) => (totalMicros > 0 ? micros / totalMicros : 0);

  const openThread = threadLinks
    ? (member: ThreadFamilyPricingMember) => threadLinks.show({
        backend: member.backend,
        threadId: member.threadId,
        title: member.title,
      })
    : undefined;

  return (
    <div className="rail-summary-card thread-family-pricing">
      <div className="rail-summary-card__header">
        <span className="rail-summary-card__eyebrow">Thread + sub-threads</span>
        <span className="rail-summary-card__meta">as of {formatTimestamp(result.family.readAt)}</span>
      </div>
      <div className="rail-summary-card__headline">
        <span className="rail-summary-card__primary">{formatTokenUsageMicrosAsUsd(totalMicros)}</span>
        <span className="rail-summary-card__secondary">
          sub-threads {formatTokenUsageMicrosAsUsd(subThreadMicros)}
        </span>
      </div>
      {totalMicros > 0 ? (
        <div
          className="thread-family-pricing__share"
          role="img"
          aria-label={`This thread ${formatPercent(share(self.totalCostMicros))}, sub-threads ${formatPercent(share(subThreadMicros))}`}
        >
          {members.map((member, index) => member.totalCostMicros > 0 ? (
            <i
              key={`${member.backend}:${member.threadId}`}
              className={`thread-family-pricing__segment ${swatchClass(index)}`}
              style={{ flexGrow: member.totalCostMicros }}
            />
          ) : null)}
        </div>
      ) : null}
      {unpricedRows > 0 ? (
        <div className="thread-family-pricing__warning">
          {unpricedRows.toLocaleString()} row{unpricedRows === 1 ? "" : "s"} in {unpriced.length.toLocaleString()}{" "}
          thread{unpriced.length === 1 ? "" : "s"} could not be priced
        </div>
      ) : null}
      <div className="rail-summary-card__section thread-family-pricing__members">
        <FamilyMemberRow member={self} label="This thread" swatch={swatchClass(0)} />
        {listed.map((member) => (
          <FamilyMemberRow
            key={`${member.backend}:${member.threadId}`}
            member={member}
            label={member.title}
            swatch={swatchClass(members.indexOf(member))}
            onOpen={openThread}
          />
        ))}
        {folded.length > 0 ? (
          <button
            className="thread-family-pricing__fold"
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <span className="thread-family-pricing__chevron" aria-hidden="true">›</span>
            <span className="thread-family-pricing__fold-label">
              {expanded ? "Show fewer" : `${folded.length.toLocaleString()} more sub-thread${folded.length === 1 ? "" : "s"}`}
            </span>
            {expanded ? null : (
              <span className="thread-family-pricing__cost">{formatTokenUsageMicrosAsUsd(foldedMicros)}</span>
            )}
          </button>
        ) : null}
      </div>
      <div className="thread-family-pricing__foot">
        <span>
          {running > 0
            ? `${running.toLocaleString()} thread${running === 1 ? "" : "s"} running`
            : "Includes sub-agents"}
        </span>
        <button className="thread-family-pricing__refresh" type="button" onClick={() => setRefreshes((count) => count + 1)}>
          Refresh
        </button>
      </div>
    </div>
  );
});

function FamilyMemberRow(props: {
  member: ThreadFamilyPricingMember;
  label: string;
  swatch: string;
  onOpen?: (member: ThreadFamilyPricingMember) => void;
}) {
  const content = (
    <>
      <i className={`thread-family-pricing__swatch ${props.swatch}`} aria-hidden="true" />
      <span className="thread-family-pricing__title">{props.label}</span>
      {props.member.active ? <span className="thread-family-pricing__live" role="img" aria-label="Running" /> : null}
      <span className="thread-family-pricing__cost">{formatTokenUsageMicrosAsUsd(props.member.totalCostMicros)}</span>
    </>
  );
  if (!props.onOpen) {
    return <div className={`thread-family-pricing__row${props.member.self ? " thread-family-pricing__row--self" : ""}`}>{content}</div>;
  }
  return (
    <button
      className="thread-family-pricing__row thread-family-pricing__row--link"
      type="button"
      title={`Open ${props.label}`}
      onClick={() => props.onOpen?.(props.member)}
    >
      {content}
    </button>
  );
}

/** The thread itself takes the accent; the four costliest sub-threads take the chart series. */
function swatchClass(memberIndex: number): string {
  return memberIndex <= NAMED_SUB_THREADS
    ? `thread-family-pricing__series-${memberIndex + 1}`
    : "thread-family-pricing__series-other";
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
