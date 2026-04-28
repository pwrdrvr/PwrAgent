import type { AppServerThreadReviewEntry } from "@pwragnt/shared";
import { ThreadMarkdown } from "./ThreadMarkdown";

type TranscriptReviewProps = {
  entry: AppServerThreadReviewEntry;
};

function formatConfidence(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return `${Math.round(value * 100)}% confidence`;
}

function formatPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.slice(-3).join("/") || path;
}

function priorityLabel(priority: number | undefined): string {
  return typeof priority === "number" ? `P${priority}` : "P?";
}

export function TranscriptReview(props: TranscriptReviewProps) {
  const output = props.entry.output;
  const findings = output?.findings ?? [];
  const findingCount = output?.findings.length;
  const summary =
    props.entry.displayText ??
    (findingCount === undefined
      ? "Code review"
      : `${findingCount} review ${findingCount === 1 ? "finding" : "findings"}`);
  const body =
    output?.overall_explanation ??
    (props.entry.review.trim() === summary.trim() ? "" : props.entry.review);
  const confidence = formatConfidence(output?.overall_confidence_score);
  const correctness =
    output?.overall_correctness === "patch is correct"
      ? "Patch correct"
      : output?.overall_correctness === "patch is incorrect"
        ? "Patch needs work"
        : undefined;

  return (
    <aside className="transcript-review" role="group" aria-label="Code review">
      <header className="transcript-review__header">
        <div className="transcript-review__copy">
          <p className="transcript-review__eyebrow">Review</p>
          <p className="transcript-review__summary">{summary}</p>
          {body ? (
            <ThreadMarkdown className="transcript-review__body" text={body} />
          ) : null}
        </div>
        {props.entry.createdAt ? (
          <time className="transcript-message__time">
            {new Intl.DateTimeFormat(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            }).format(props.entry.createdAt)}
          </time>
        ) : null}
      </header>

      {output ? (
        <div className="transcript-review__meta" aria-label="Review summary">
          {correctness ? (
            <span
              className={`transcript-review__badge transcript-review__badge--${
                output.overall_correctness === "patch is correct" ? "success" : "danger"
              }`}
            >
              {correctness}
            </span>
          ) : null}
          <span className="transcript-review__badge">
            {findingCount} {findingCount === 1 ? "finding" : "findings"}
          </span>
          {confidence ? (
            <span className="transcript-review__badge">{confidence}</span>
          ) : null}
        </div>
      ) : null}

      {findings.length > 0 ? (
        <ol className="transcript-review__findings">
          {findings.map((finding, index) => {
            const range = finding.code_location.line_range;
            return (
              <li
                className="transcript-review__finding"
                key={`${finding.code_location.absolute_file_path}:${range.start}:${index}`}
              >
                <div className="transcript-review__finding-head">
                  <span className="transcript-review__priority">
                    {priorityLabel(finding.priority)}
                  </span>
                  <span className="transcript-review__finding-title">
                    {finding.title}
                  </span>
                </div>
                <ThreadMarkdown
                  className="transcript-review__finding-body"
                  text={finding.body}
                />
                <div className="transcript-review__location">
                  <span>{formatPath(finding.code_location.absolute_file_path)}</span>
                  <span>
                    {range.start === range.end
                      ? `Line ${range.start}`
                      : `Lines ${range.start}-${range.end}`}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      ) : output ? (
        <p className="transcript-review__empty">No findings.</p>
      ) : null}
    </aside>
  );
}
