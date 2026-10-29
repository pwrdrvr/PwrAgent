import {
  formatTokenUsageMicrosAsUsd,
  type AppServerBackendKind,
  type FederationRemoteTarget,
  type ReadThreadFamilyPricingResponse,
  type ThreadFamilyPricingMember,
} from "@pwragent/shared";
import { memo, useEffect, useState } from "react";
import type { DesktopApi } from "../../../lib/desktop-api";
import { useFederationInstanceNameLookup } from "../../../lib/federation-display-label";
import { readRendererFederationTarget } from "../../../lib/federation-window";
import { useThreadLinks } from "../../../lib/thread-links";

type ThreadFamilyPricingCardProps = {
  desktopApi?: Pick<DesktopApi, "readThreadFamilyPricing">;
  backend: AppServerBackendKind;
  threadId: string;
  federationTarget?: FederationRemoteTarget;
  /** Ordinary sub-threads directly under this one; zero renders nothing. */
  subThreadCount: number;
};

/** Sub-threads past this many share the neutral swatch and fold into one row. */
const NAMED_SUB_THREADS = 4;

type FamilyRead =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "ready"; family: ReadThreadFamilyPricingResponse };

/**
 * What a thread and every sub-thread under it cost, from each thread's stored
 * running total. Sub-threads on other machines count too: main asks each
 * owner for its own threads' totals. A row names its machine when that
 * differs from this thread's, and a machine that cannot be reached leaves
 * its rows listed but out of the total. It is read when the Pricing tab opens, when the sub-thread
 * count changes, and on Refresh, never per streamed event: a running
 * sub-thread keeps spending after the read, and the card says so rather than
 * re-reading underneath the operator.
 *
 * Render it keyed by thread identity: every piece of state here belongs to
 * one thread.
 */
export const ThreadFamilyPricingCard = memo(function ThreadFamilyPricingCard(props: ThreadFamilyPricingCardProps) {
  const read = props.desktopApi?.readThreadFamilyPricing;
  const enabled = Boolean(read) && props.subThreadCount > 0;
  const [result, setResult] = useState<FamilyRead>({ state: "loading" });
  const [refreshes, setRefreshes] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const threadLinks = useThreadLinks();
  const instanceNames = useFederationInstanceNameLookup();
  const ownerInstanceId = props.federationTarget?.instanceId;

  useEffect(() => {
    if (!enabled || !read) return;
    let current = true;
    // A re-read keeps the last totals on screen until the new ones land.
    setResult((previous) => previous.state === "ready" ? previous : { state: "loading" });
    read({ backend: props.backend, threadId: props.threadId,
      ...(ownerInstanceId ? { federationTarget: { scope: "remote", instanceId: ownerInstanceId } as const } : {}),
    }).then(
      (family) => { if (current) setResult({ state: "ready", family }); },
      () => { if (current) setResult({ state: "failed" }); },
    );
    return () => { current = false; };
  }, [enabled, read, props.backend, props.threadId, props.subThreadCount, ownerInstanceId, refreshes]);

  if (!enabled) return null;

  if (result.state === "loading") {
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
  const unreachable = members.filter((member) => member.unavailable);
  // Either gap makes the total a floor, not the whole bill.
  const partial = unpricedRows > 0 || unreachable.length > 0;
  const machineName = (member: ThreadFamilyPricingMember): string | undefined => member.ownerInstanceId
    ? instanceNames(member.ownerInstanceId, member.instanceLabel ?? "Another machine").label
    : "This machine";
  // Rows on this thread's own machine go unlabeled.
  const machineLabel = (member: ThreadFamilyPricingMember): string | undefined =>
    member.ownerInstanceId === self.ownerInstanceId ? undefined : machineName(member);
  const running = members.filter((member) => member.active).length;
  const named = subThreads.slice(0, NAMED_SUB_THREADS);
  const folded = subThreads.slice(NAMED_SUB_THREADS);
  const foldedMicros = folded.reduce((sum, member) => sum + member.totalCostMicros, 0);
  const listed = expanded ? subThreads : named;
  const share = (micros: number) => (totalMicros > 0 ? micros / totalMicros : 0);

  // A window bound to another instance shows only that instance's threads,
  // so a thread on this machine cannot open there.
  const windowOwner = readRendererFederationTarget()?.instanceId;
  const openThread = threadLinks
    ? (member: ThreadFamilyPricingMember) => threadLinks.show({
        backend: member.backend,
        threadId: member.threadId,
        title: member.title,
        ...(member.ownerInstanceId ? { instanceId: member.ownerInstanceId } : {}),
        ...(member.ownerInstanceId && member.instanceLabel ? { instanceLabel: member.instanceLabel } : {}),
      })
    : undefined;
  const opener = (member: ThreadFamilyPricingMember) =>
    member.unavailable || (windowOwner && !member.ownerInstanceId) ? undefined : openThread;

  return (
    <div className="rail-summary-card thread-family-pricing">
      <div className="rail-summary-card__header">
        <span className="rail-summary-card__eyebrow">Thread + sub-threads</span>
        <span className="rail-summary-card__meta">as of {formatReadTime(result.family.readAt)}</span>
      </div>
      <div className="rail-summary-card__headline">
        <span className="rail-summary-card__primary">
          {formatTokenUsageMicrosAsUsd(totalMicros)}{partial ? "+" : ""}
        </span>
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
              key={`${member.ownerInstanceId ?? ""}:${member.backend}:${member.threadId}`}
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
      {unreachable.length > 0 ? (
        <div className="thread-family-pricing__warning">{unreachableWarning(unreachable.map(machineName))}</div>
      ) : null}
      <div className="rail-summary-card__section thread-family-pricing__members">
        <FamilyMemberRow member={self} label="This thread" swatch={swatchClass(0)} />
        {listed.map((member) => (
          <FamilyMemberRow
            key={`${member.ownerInstanceId ?? ""}:${member.backend}:${member.threadId}`}
            member={member}
            label={member.title}
            machine={machineLabel(member)}
            swatch={swatchClass(members.indexOf(member))}
            onOpen={opener(member)}
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
  /** The machine that keeps the thread, when it is not this thread's. */
  machine?: string;
  swatch: string;
  onOpen?: (member: ThreadFamilyPricingMember) => void;
}) {
  const unavailable = Boolean(props.member.unavailable);
  const content = (
    <>
      <i className={`thread-family-pricing__swatch ${unavailable ? "" : props.swatch}`} aria-hidden="true" />
      <span className="thread-family-pricing__name">
        <span className="thread-family-pricing__title">{props.label}</span>
        {props.machine ? <span className="thread-family-pricing__machine">{props.machine}</span> : null}
      </span>
      {props.member.active ? <span className="thread-family-pricing__live" role="img" aria-label="Running" /> : null}
      <span className="thread-family-pricing__cost">
        {unavailable ? "not included" : formatTokenUsageMicrosAsUsd(props.member.totalCostMicros)}
      </span>
    </>
  );
  const name = props.machine ? `${props.label} on ${props.machine}` : props.label;
  if (!props.onOpen) {
    const modifier = props.member.self ? " thread-family-pricing__row--self"
      : unavailable ? " thread-family-pricing__row--off" : "";
    return (
      <div
        className={`thread-family-pricing__row${modifier}`}
        {...(unavailable ? { title: `${name} could not be read` } : {})}
      >
        {content}
      </div>
    );
  }
  return (
    <button
      className="thread-family-pricing__row thread-family-pricing__row--link"
      type="button"
      title={`Open ${name}`}
      onClick={() => props.onOpen?.(props.member)}
    >
      {content}
    </button>
  );
}

/**
 * "1 sub-thread on M2 Max could not be read", naming up to two machines. The
 * owner may be offline, older, or not granting this machine thread detail.
 */
function unreachableWarning(machines: Array<string | undefined>): string {
  const names = [...new Set(machines.filter((name): name is string => Boolean(name)))];
  const count = machines.length;
  const where = names.length === 0 ? ""
    : names.length <= 2 ? ` on ${names.join(" and ")}`
    : ` on ${names.length.toLocaleString()} machines`;
  return `${count.toLocaleString()} sub-thread${count === 1 ? "" : "s"}${where} could not be read`;
}

/** The thread itself takes the accent; the four costliest sub-threads take the chart series. */
function swatchClass(memberIndex: number): string {
  return memberIndex <= NAMED_SUB_THREADS
    ? `thread-family-pricing__series-${memberIndex + 1}`
    : "thread-family-pricing__series-other";
}

/**
 * The read happens when the tab opens, so the time alone says how fresh it
 * is. A date beside it squeezed the eyebrow onto three lines at the rail's
 * minimum width.
 */
function formatReadTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(timestamp);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
