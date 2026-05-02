import type {
  AppServerThreadPlanEntry,
  DesktopApplicationsSnapshot,
} from "@pwragnt/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { ThreadMarkdown } from "./ThreadMarkdown";

type TranscriptPlanProps = {
  applications?: DesktopApplicationsSnapshot;
  desktopApi?: Pick<DesktopApi, "openApplication">;
  entry: AppServerThreadPlanEntry;
};

function formatPlanSummary(completedCount: number, totalCount: number): string {
  const taskLabel = totalCount === 1 ? "task" : "tasks";
  return `${completedCount} out of ${totalCount} ${taskLabel} completed`;
}

function formatStepStatus(status: AppServerThreadPlanEntry["steps"][number]["status"]): string {
  if (status === "in_progress") {
    return "In progress";
  }
  return status[0].toUpperCase() + status.slice(1);
}

export function TranscriptPlan(props: TranscriptPlanProps) {
  const completedCount = props.entry.steps.filter(
    (step) => step.status === "completed"
  ).length;

  return (
    <aside className="transcript-plan" role="group" aria-label="Task plan">
      <header className="transcript-plan__header">
        <div className="transcript-plan__copy">
          <p className="transcript-plan__summary">
            {props.entry.steps.length > 0
              ? formatPlanSummary(completedCount, props.entry.steps.length)
              : "Plan update"}
          </p>
          {props.entry.explanation ? (
            <p className="transcript-plan__explanation">{props.entry.explanation}</p>
          ) : null}
        </div>
        {props.entry.createdAt ? (
          <time className="transcript-message__time">
            {new Intl.DateTimeFormat(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit"
            }).format(props.entry.createdAt)}
          </time>
        ) : null}
      </header>

      {props.entry.steps.length > 0 ? (
        <ol className="transcript-plan__steps">
          {props.entry.steps.map((step, index) => (
            <li key={`${step.status}:${step.step}:${index}`} className="transcript-plan__step">
              <span
                className={`transcript-plan__step-status transcript-plan__step-status--${step.status}`}
                aria-hidden="true"
              />
              <span className="transcript-plan__step-index">{index + 1}.</span>
              <span className="transcript-plan__step-text">{step.step}</span>
              <span className="transcript-plan__step-label">
                {formatStepStatus(step.status)}
              </span>
            </li>
          ))}
        </ol>
      ) : null}

      {props.entry.markdown ? (
        <ThreadMarkdown
          applications={props.applications}
          className="transcript-plan__markdown"
          desktopApi={props.desktopApi}
          text={props.entry.markdown}
        />
      ) : null}
    </aside>
  );
}
