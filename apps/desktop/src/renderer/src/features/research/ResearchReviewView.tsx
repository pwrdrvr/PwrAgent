import { useId, useState } from "react";
import type { ResearchSubmission } from "@pwragent/shared";
import { ResearchThreadButton } from "./ResearchThreadButton";
import { EvidenceList } from "./ResearchViews";
import { approachTitle, researchReviewStatusLabel, researchRevisionBlocker, researchSourceLabel, type ResearchRunView } from "./research-view-model";

type Decision = NonNullable<ResearchSubmission["review"]>["decision"];

export function ResearchReviewView({ run, live, canReview, busy, evidenceAvailable, onReview, onOpenItem, onOpenEvidence }: {
  run: ResearchRunView; live: boolean; canReview: boolean; busy: boolean; evidenceAvailable: boolean;
  onReview: (submissionId: string, decision: Decision, reason: string) => Promise<boolean>;
  onOpenItem: (itemId: string) => void; onOpenEvidence: (itemId: string, pathIndex: number) => void;
}) {
  const waiting = [...run.submissions].reverse().filter((s) => !s.review);
  const reviewed = [...run.submissions].reverse().filter((s) => s.review);
  const card = (submission: ResearchSubmission) => <CandidateCard key={submission.id} run={run} submission={submission} live={live} canReview={canReview} busy={busy}
    evidenceAvailable={evidenceAvailable} onReview={onReview} onOpenItem={onOpenItem} onOpenEvidence={onOpenEvidence} />;
  return <div className="research-list" aria-label="Research candidates">
    <p className="research-muted">Accepting records a reviewer’s judgment. It is not formal verification.</p>
    {run.harness && <p className="research-muted">Source records retain their original content. PwrAgent records acceptance or rejection; revision feedback requires the source service.</p>}
    {waiting.length > 0 && <section aria-label="Candidates to review"><h4 className="research-group">To review · {waiting.length}</h4>{waiting.map(card)}</section>}
    {reviewed.length > 0 && <section aria-label="Reviewed candidates"><h4 className="research-group">Reviewed · {reviewed.length}</h4>{reviewed.map(card)}</section>}
    {!run.submissions.length && <p className="context-empty">Workers submit candidates here for the coordinator to review.</p>}
  </div>;
}

function CandidateCard({ run, submission, live, canReview, busy, evidenceAvailable, onReview, onOpenItem, onOpenEvidence }: {
  run: ResearchRunView; submission: ResearchSubmission; live: boolean; canReview: boolean; busy: boolean; evidenceAvailable: boolean;
  onReview: (submissionId: string, decision: Decision, reason: string) => Promise<boolean>;
  onOpenItem: (itemId: string) => void; onOpenEvidence: (itemId: string, pathIndex: number) => void;
}) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [changing, setChanging] = useState(false);
  const title = approachTitle(run, submission.approachId);
  const revisionBlocker = researchRevisionBlocker(run, submission, live);
  const formOpen = canReview && (!submission.review || changing);
  const decide = async (decision: Decision) => {
    if (await onReview(submission.id, decision, reason.trim())) { setReason(""); setChanging(false); }
  };
  return <article className="research-entry" aria-label={`Candidate from ${title}`}>
    <div className="research-entry__meta">
      <span>{title}</span>
      <span className={`research-chip${submission.review ? submission.review.decision === "accepted" ? " research-chip--done" : "" : " research-chip--attention"}`}>{researchReviewStatusLabel(submission.review?.decision)}</span>
    </div>
    <button type="button" className="research-entry__open" onClick={() => onOpenItem(submission.id)}>{submission.text}</button>
    {run.harness && <p className="research-muted">{researchSourceLabel(run, submission.id)}</p>}
    {submission.paths.length > 0 && <EvidenceList paths={submission.paths} available={evidenceAvailable} onOpen={(index) => onOpenEvidence(submission.id, index)} />}
    {submission.author && <ResearchThreadButton thread={submission.author} title="Open source thread" label={`Open source thread: ${title}`} />}
    {submission.review && <p className="research-review-note"><strong>{submission.review.actor.kind === "operator" ? "You" : "Coordinator"}:</strong> {submission.review.reason}</p>}
    {canReview && submission.review && !changing && <div className="research-actions"><button type="button" className="research-button research-button--ghost" onClick={() => setChanging(true)}>Change decision</button></div>}
    {formOpen && <div className="research-review-form">
      <label htmlFor={`${id}-reason`}>Reason for your decision</label>
      <textarea id={`${id}-reason`} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={2000} rows={2} aria-describedby={`${id}-hint`} />
      <p id={`${id}-hint`} className="research-muted">Required. The worker receives it with a revision request.{revisionBlocker ? ` ${revisionBlocker}` : ""}</p>
      <div className="research-actions">
        <button type="button" className="research-button research-button--primary" disabled={busy || !reason.trim()} onClick={() => { void decide("accepted"); }}>Accept</button>
        <button type="button" className="research-button" disabled={busy || !reason.trim() || Boolean(revisionBlocker)} onClick={() => { void decide("revision_requested"); }}>Request revision</button>
        <button type="button" className="research-button" disabled={busy || !reason.trim()} onClick={() => { void decide("rejected"); }}>Reject</button>
        {changing && <button type="button" className="research-button research-button--ghost" onClick={() => { setChanging(false); setReason(""); }}>Cancel</button>}
      </div>
    </div>}
  </article>;
}
