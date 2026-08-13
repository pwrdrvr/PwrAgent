import { useEffect, useMemo, useState } from "react";
import type { AutomationDetail, AutomationRunSummary } from "@pwragent/shared";
import { CloseIcon } from "../../icons";
import { useDesktopApi } from "../../lib/desktop-api";
import { AutomationRunArtifactDetails } from "./ThreadAutomationsPanel";
import { useAutomationRunArtifact } from "./useAutomations";
import {
  formatAutomationRunUsage,
  formatAutomationTimestamp,
  formatRunStatus,
} from "./automation-format";

type AutomationRunTarget = {
  automationId: string;
  runId: string;
};

/**
 * Inspection-only window for one automation run's captured events.
 *
 * Hash contract: `automation-run/<automationId>/<runId>`, each segment
 * URI-encoded (see main-process automation-run-window.ts). The window fetches
 * authoritative run + artifact data over normal IPC rather than trusting
 * anything beyond the two ids.
 */
export function AutomationRunWindow() {
  const desktopApi = useDesktopApi();
  const target = useMemo(() => automationRunTargetFromHash(), []);
  const [automation, setAutomation] = useState<AutomationDetail>();
  const [run, setRun] = useState<AutomationRunSummary>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(Boolean(target));
  const artifact = useAutomationRunArtifact(desktopApi, target?.runId);

  useEffect(() => {
    if (!target) {
      setError("This automation run address is invalid.");
      setLoading(false);
      return;
    }
    const listAutomations = desktopApi?.listAutomations;
    const listRuns = desktopApi?.listAutomationRuns;
    if (!listAutomations || !listRuns) {
      setError("The desktop bridge is unavailable.");
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [automationsResponse, runsResponse] = await Promise.all([
          listAutomations({}),
          listRuns({ automationId: target.automationId }),
        ]);
        if (cancelled) return;
        setAutomation(
          automationsResponse.automations.find(
            (candidate) => candidate.id === target.automationId,
          ),
        );
        setRun(
          runsResponse.runs.find((candidate) => candidate.id === target.runId),
        );
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [desktopApi, target]);

  const usageLine = formatAutomationRunUsage(run?.usage);

  return (
    <div className="automation-run-window">
      <section aria-label="Automation run" className="activity-screen">
        <header className="activity-titlebar">
          <p className="activity-titlebar__brand">
            Pwr<span className="activity-titlebar__brand-accent">Agent</span>
          </p>
          {/* No aria-label: the Messaging Activity, License, and Changelog
              windows all let this breadcrumb read its own content, and a
              label here only overrode "Automations Run" with an ASCII ">"
              that screen readers voice as "greater than". */}
          <div className="activity-titlebar__breadcrumb">
            <span className="activity-titlebar__eyebrow">Automations</span>
            <span aria-hidden="true" className="activity-titlebar__separator">
              ›
            </span>
            <span className="activity-titlebar__current">
              {automation?.name ?? "Run"}
            </span>
          </div>
          <div className="activity-titlebar__spacer" />
        </header>

        <main className="automation-run-window__content">
          <header className="automation-run-window__header">
            <div className="automation-run-window__identity">
              <h1>{automation?.name ?? "Automation run"}</h1>
              {run ? (
                <p>
                  <span
                    className={`automation-run-status automation-run-status--${run.status}`}
                  >
                    {formatRunStatus(run.status)}
                  </span>
                  <span>
                    {run.trigger} ·{" "}
                    {formatAutomationTimestamp(
                      run.completedAt ?? run.startedAt ?? run.queuedAt,
                    )}
                  </span>
                  {usageLine ? <span>{usageLine}</span> : null}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              className="automation-run-window__close"
              aria-label="Close window"
              title="Close"
              onClick={() => window.close()}
            >
              <CloseIcon size={18} aria-hidden="true" />
            </button>
          </header>

          {error ? (
            <p className="automations-error" role="alert">
              {error}
            </p>
          ) : loading ? (
            <p className="automation-run-history__time">Loading run…</p>
          ) : !run ? (
            <p className="automation-run-history__time">
              This run is no longer in the retained history.
            </p>
          ) : (
            <div className="automation-run-history">
              <AutomationRunArtifactDetails
                backendThreadId={run.backendThreadId}
                backendTurnId={run.backendTurnId}
                error={artifact.error}
                finalText={artifact.artifact?.finalText}
                loading={artifact.loading}
                outputDecision={artifact.artifact?.outputDecision?.kind}
                rollout={artifact.rollout}
                scheduledWindows={run.scheduledWindows}
                status={run.status}
                transcriptEvents={artifact.artifact?.transcriptEvents ?? []}
              />
            </div>
          )}
        </main>
      </section>
    </div>
  );
}

function automationRunTargetFromHash(): AutomationRunTarget | undefined {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash.startsWith("automation-run/")) return undefined;
  const segments = hash.split("/").slice(1);
  const automationId = segments[0] ? decodeURIComponent(segments[0]) : "";
  const runId = segments[1] ? decodeURIComponent(segments[1]) : "";
  if (!automationId || !runId) return undefined;
  return { automationId, runId };
}
