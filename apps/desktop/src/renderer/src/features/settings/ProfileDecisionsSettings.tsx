import { useCallback, useEffect, useState } from "react";
import type { DecisionsProfileDecision } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { useModalDialog } from "../../lib/useModalDialog";
import {
  decisionInputSchemaSummary,
  decisionProviderLabel,
  decisionSummaryLine,
  formatDecisionClock,
} from "../thread-detail/context-panels/decisions-format";
import { SettingsSection } from "./SettingsLayout";
import "./profile-decisions.css";

type ProfileDecisionsApi = Pick<DesktopApi, "readProfileDecisions" | "deleteProfileDecision">;

/**
 * AI Providers → Decisions: the profile-scope decisions agents registered.
 * They outlive the thread that registered them, so this is where the
 * operator sees them all and deletes one. A thread's own decisions stay on
 * its Decisions tab. Decisions live on the owner, so a federation window
 * shows none.
 */
export function ProfileDecisionsSettings(props: { desktopApi?: ProfileDecisionsApi; now?: number }) {
  const read = props.desktopApi?.readProfileDecisions;
  const available = Boolean(read) && !readRendererFederationTarget();
  const [decisions, setDecisions] = useState<DecisionsProfileDecision[]>();
  const [loadError, setLoadError] = useState(false);
  const [candidate, setCandidate] = useState<DecisionsProfileDecision>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();

  const load = useCallback(async (): Promise<void> => {
    if (!read) return;
    try {
      setDecisions((await read()).decisions);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [read]);

  useEffect(() => {
    if (available) void load();
  }, [available, load]);

  const closeConfirm = (): void => {
    setCandidate(undefined);
    setDeleteError(undefined);
  };
  const confirmRef = useModalDialog({ open: candidate !== undefined, onClose: closeConfirm });

  const remove = async (): Promise<void> => {
    const deleteDecision = props.desktopApi?.deleteProfileDecision;
    if (!candidate || !deleteDecision) return;
    setDeleting(true);
    setDeleteError(undefined);
    try {
      // "not_found" means an agent deleted it first: the list catches up either way.
      await deleteDecision({ decisionId: candidate.decisionId });
      setCandidate(undefined);
      await load();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Couldn't delete the decision.");
    } finally {
      setDeleting(false);
    }
  };

  if (!available) return null;
  const now = props.now ?? Date.now();
  return (
    <SettingsSection
      eyebrow="Decisions"
      title="Profile decisions"
      sectionId="profile-decisions"
      chip={decisions ? String(decisions.length) : undefined}
      description="Decisions an agent registered for this whole profile. Every thread can run them, and they stay until you or an agent delete them. A thread's own decisions are on its Decisions tab."
    >
      <div className="profile-decisions-body">
        {decisions === undefined ? (
          <p className={loadError ? "settings-error" : "settings-empty"}>
            {loadError ? "Couldn't read the profile's decisions." : "Reading the profile's decisions…"}
          </p>
        ) : decisions.length === 0 ? (
          <p className="settings-empty">
            No profile decisions. Agents register one with <code>decisions_register</code> and
            scope <code>profile</code>.
          </p>
        ) : (
          <>
            {loadError ? <p className="settings-error" role="status">Couldn't refresh. Showing the last read.</p> : null}
            <ul className="profile-decisions" aria-label="Profile decisions">
              {decisions.map((decision) => (
                <li key={decision.decisionId} className="profile-decisions__row">
                  <div className="profile-decisions__main">
                    <p className="profile-decisions__title">
                      <span className="profile-decisions__name">{decision.name}</span>
                      <span
                        className={`settings-pathrow__chip${decision.providerDisabled ? " profile-decisions__chip--off" : ""}`}
                      >
                        {decisionProviderLabel(decision.provider)}
                        {decision.providerDisabled ? " · off" : ""}
                      </span>
                      <span className="settings-pathrow__chip">v{decision.version}</span>
                    </p>
                    <p className="profile-decisions__meta">
                      {decisionSummaryLine(decision)} · input{" "}
                      <code>{decisionInputSchemaSummary(decision.inputSchema)}</code> · registered{" "}
                      {formatDecisionClock(decision.createdAt, now)}
                    </p>
                  </div>
                  <button
                    className="button button--ghost settings-danger-button"
                    type="button"
                    aria-label={`Delete ${decision.name}`}
                    onClick={() => setCandidate(decision)}
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      {candidate ? (
        <div className="settings-confirm-modal" role="presentation">
          <div
            ref={confirmRef}
            aria-labelledby="delete-profile-decision-heading"
            aria-modal="true"
            className="settings-confirm-dialog settings-confirm-dialog--danger"
            role="dialog"
          >
            <h2 id="delete-profile-decision-heading">Delete {candidate.name}?</h2>
            <p>
              No thread on this profile can run <strong>{candidate.name}</strong> after this: a call by
              its name or id fails. Batches already running on it finish. An agent can register it
              again.
            </p>
            {deleteError ? <p className="settings-error" role="alert">{deleteError}</p> : null}
            <div className="settings-confirm-dialog__actions">
              <button className="button button--secondary" type="button" onClick={closeConfirm}>
                Cancel
              </button>
              <button
                className="button button--ghost settings-danger-button"
                disabled={deleting}
                type="button"
                onClick={() => void remove()}
              >
                {deleting ? "Deleting…" : "Delete decision"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </SettingsSection>
  );
}
