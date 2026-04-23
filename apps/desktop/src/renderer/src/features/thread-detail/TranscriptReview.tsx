import type { AppServerThreadReviewEntry } from "@pwragnt/shared";
import { ThreadMarkdown } from "./ThreadMarkdown";

type TranscriptReviewProps = {
  entry: AppServerThreadReviewEntry;
};

export function TranscriptReview(props: TranscriptReviewProps) {
  const findingCount = props.entry.output?.findings.length;
  const summary =
    props.entry.displayText ??
    (findingCount === undefined
      ? "Code review"
      : `${findingCount} review ${findingCount === 1 ? "finding" : "findings"}`);
  const body = props.entry.review.trim() === summary.trim() ? "" : props.entry.review;

  return (
    <aside className="transcript-review" role="group" aria-label="Code review">
      <header className="transcript-plan__header">
        <div className="transcript-plan__copy">
          <p className="transcript-plan__summary">{summary}</p>
          {props.entry.output?.overall_correctness ? (
            <p className="transcript-plan__explanation">
              {props.entry.output.overall_correctness}
            </p>
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
      {body ? (
        <ThreadMarkdown className="transcript-plan__markdown" text={body} />
      ) : null}
    </aside>
  );
}
