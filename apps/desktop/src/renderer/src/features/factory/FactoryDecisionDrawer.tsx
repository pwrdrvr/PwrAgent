import { useState, type RefObject } from "react";
import { parseThreadUrl } from "@pwragent/shared/contracts/thread-link";
import type { FactoryEvidenceSnapshot, FactoryReceiptProjection } from "@pwragent/shared/factory-projection";
import type { FactoryWorkItem } from "@pwragent/shared/factory-work-item";
import { FactoryObservationTime } from "./FactoryObservationTime";
import { RECEIPT_STATUS, revisionNotice, trackingLabel, type FactoryRevision, type FactoryRow } from "./factory-board";

export function FactoryDecisionDrawer(props: {
  row: FactoryRow;
  evidence?: FactoryEvidenceSnapshot;
  expected?: FactoryRevision;
  checks?: string[];
  unavailable?: "missing" | "mismatch";
  observedAt?: number;
  trackedNumber?: number;
  busy: boolean;
  online: boolean;
  canCompare: boolean;
  drawerRef: RefObject<HTMLElement | null>;
  titleRef: RefObject<HTMLHeadingElement | null>;
  onClose: () => void;
  onRefresh: (checks?: string[]) => void;
  onCompare: () => void;
  openThread: (reference: string) => Promise<void>;
}) {
  const { row, evidence, expected } = props;
  const [navigationError, setNavigationError] = useState("");
  const revision = evidence?.revision ?? (row.branch
    ? { headOid: row.branch.headOid, baseOid: row.branch.baseOid }
    : undefined);
  const stale = evidence && revisionNotice(evidence.revisionState);
  return (
    <aside className="factory-drawer" id="factory-drawer" aria-labelledby="factory-outcome-title" ref={props.drawerRef}>
      <div className="factory-drawer-top">
        <span className="factory-context">{row.context}</span>
        <button className="button button--secondary" type="button" onClick={props.onClose}>Back to board</button>
      </div>
      <h2 id="factory-outcome-title" tabIndex={-1} ref={props.titleRef}>{row.title}</h2>
      <p className="factory-reason"><strong>{row.lane}</strong> · {row.reason}</p>
      {row.branch ? <TrackingRecord item={row.branch.workItem} /> : null}
      {stale && stale !== row.reason ? <p className="factory-warning">{stale}</p> : null}
      {props.unavailable ? (
        <p className="factory-warning">{props.unavailable === "mismatch"
          ? "The selected PR does not match the local branch and target."
          : "GitHub did not confirm this selection."}</p>
      ) : null}
      {revision ? (
        <dl className="factory-revisions">
          <Revision label={row.pr ? "PR head" : "Local head"} value={revision.headOid} />
          <Revision label={row.pr ? "Target base" : "Local base"} value={revision.baseOid} />
          {expected && expected.headOid !== revision.headOid ? <Revision label="Earlier head" value={expected.headOid} /> : null}
          {expected && expected.baseOid !== revision.baseOid ? <Revision label="Earlier base" value={expected.baseOid} /> : null}
        </dl>
      ) : null}
      {row.compared ? (
        <dl className="factory-revisions">
          <Revision label="Published head at comparison" value={row.compared.headOid} />
          <Revision label="Published target at comparison" value={row.compared.baseOid} />
        </dl>
      ) : null}
      {evidence?.mergeCommitOid ? <dl className="factory-revisions"><Revision label="Merge commit" value={evidence.mergeCommitOid} /></dl> : null}

      <section className="factory-drawer-section" aria-label="Available actions">
        <h3>Available actions</h3>
        <div className="factory-actions">
          {row.pr && props.unavailable !== "missing" ? (
            <a className="button button--secondary" href={row.pr.url} target="_blank" rel="noreferrer">Open on GitHub</a>
          ) : null}
          <button className="button button--secondary" type="button" onClick={() => props.onRefresh()}
            disabled={props.busy || (!!row.pr && !props.online)}>
            {row.pr && !evidence ? "Read evidence" : "Refresh evidence"}
          </button>
          {props.canCompare || props.trackedNumber !== undefined ? (
            <button className="button button--secondary" type="button" onClick={props.onCompare} disabled={props.busy || !props.online}>
              {props.trackedNumber === undefined ? "Compare with local branch" : `Compare tracked PR #${props.trackedNumber}`}
            </button>
          ) : null}
        </div>
        {row.pr ? <p>Landing unavailable. Independent review clearance and exact integration evidence are required.</p> : null}
      </section>

      <section className="factory-drawer-section" aria-label="Owner evidence">
        <h3>Evidence</h3>
        {props.observedAt !== undefined ? <FactoryObservationTime label="GitHub evidence observed" value={props.observedAt} /> : null}
        {evidence ? (
          <>
            <dl className="factory-revisions">
              <Revision label="CI" value={ciLabels[evidence.ci]} />
              <Revision label="Review" value={reviewLabels[evidence.review]} />
            </dl>
            <CheckSelection key={props.checks?.join("\n")} checks={props.checks ?? []} disabled={props.busy || !props.online}
              onApply={props.onRefresh} />
          </>
        ) : null}
        {navigationError ? <p role="alert">{navigationError}</p> : null}
        <ReceiptList receipts={evidence?.receipts ?? []} onOpenThread={open} />
        {row.branch ? (
          <>
            <FactoryObservationTime label="Local branch observed" value={row.branch.authority.observedAt} />
            <ReceiptList receipts={row.branch.receipts} onOpenThread={open} heading={row.pr ? "Local branch reviews" : undefined} />
          </>
        ) : null}
        {!evidence && !row.branch?.receipts.length ? (
          <p>{row.pr ? "Pull request evidence has yet to be confirmed." : "No review evidence was confirmed for this branch."}</p>
        ) : null}
      </section>
    </aside>
  );

  function open(reference: string) {
    setNavigationError("");
    void props.openThread(reference).catch(() => setNavigationError("Could not open the evidence thread."));
  }
}

const ciLabels: Record<FactoryEvidenceSnapshot["ci"], string> = {
  absent: "Missing", pending: "Pending", failed: "Failed", conflict: "Conflicting", inconclusive: "Inconclusive", passed: "Passed",
};
const reviewLabels: Record<FactoryEvidenceSnapshot["review"], string> = {
  absent: "Clearance missing", stale_head: "Stale head", blocked: "Blocked", inconclusive: "Inconclusive", conflict: "Conflicting",
};

function Revision({ label, value }: { label: string; value?: string }) {
  return <div><dt>{label}</dt><dd><code>{value ?? "Missing"}</code></dd></div>;
}

function TrackingRecord({ item }: { item: FactoryWorkItem }) {
  const reference = item.provider === "github" ? `${item.repositoryId} #${item.number}`
    : item.provider === "jira" ? `${item.siteId} / ${item.id}` : item.id;
  return <p className="factory-context">{trackingLabel(item)} <code>{reference}</code> · Operator selected</p>;
}

function CheckSelection(props: { checks: string[]; disabled: boolean; onApply: (checks: string[]) => void }) {
  return (
    <details className="factory-checks">
      <summary>Required CI checks</summary>
      <form onSubmit={(event) => {
        event.preventDefault();
        const value = String(new FormData(event.currentTarget).get("checks") ?? "");
        props.onApply(value.split("\n").map((name) => name.trim()).filter(Boolean));
      }}>
        <label>
          Check names, one per line
          <textarea className="settings-input" name="checks" rows={3} defaultValue={props.checks.join("\n")}
            maxLength={16_384} disabled={props.disabled} />
        </label>
        <button className="button button--secondary" type="submit" disabled={props.disabled}>Read with these checks</button>
      </form>
    </details>
  );
}

function ReceiptList(props: {
  receipts: FactoryReceiptProjection[];
  onOpenThread: (reference: string) => void;
  heading?: string;
}) {
  if (!props.receipts.length) return null;
  return (
    <>
      {props.heading ? <h4>{props.heading}</h4> : null}
      <ul className="factory-receipts">
        {props.receipts.map((receipt, index) => (
          <li key={`${receipt.source}:${receipt.name}:${index}`}>
            <div className="factory-receipt-line">
              <strong>{receipt.name}</strong>
              <span data-status={receipt.status}>{RECEIPT_STATUS[receipt.status]}</span>
            </div>
            <div className="factory-context">
              {receipt.source === "github" ? "GitHub" : receipt.source === "owner_review" ? "Owner review" : "Owner PR status"}
              {receipt.actor ? ` · ${receipt.actor}` : ""}
              {receipt.required ? " · Required" : ""}
              {receipt.headOid ? <span> · Head <code title={receipt.headOid}>{receipt.headOid.slice(0, 12)}</code></span> : null}
              {receipt.baseOid ? <span> · Target base <code title={receipt.baseOid}>{receipt.baseOid.slice(0, 12)}</code></span> : null}
              {receipt.mergeBaseOid ? <span> · <span>Reviewed merge base</span> <code title={receipt.mergeBaseOid}>{receipt.mergeBaseOid.slice(0, 12)}</code></span> : null}
            </div>
            <ReceiptLink receipt={receipt} onOpenThread={props.onOpenThread} />
          </li>
        ))}
      </ul>
    </>
  );
}

function ReceiptLink({ receipt, onOpenThread }: {
  receipt: FactoryReceiptProjection;
  onOpenThread: (reference: string) => void;
}) {
  const { reference } = receipt;
  if (!reference) return null;
  const target = receipt.source === "owner_review" ? parseThreadUrl(reference) : undefined;
  if (target?.backend && !target.instanceId && !target.profile) {
    return (
      <button className="button button--secondary" type="button" onClick={() => onOpenThread(reference)}>
        Open review thread
      </button>
    );
  }
  return reference.startsWith("https://github.com/")
    ? <a href={reference} target="_blank" rel="noreferrer">View on GitHub</a>
    : null;
}
