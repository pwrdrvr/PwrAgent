import { useId, useState } from "react";
import type { AppServerThreadActivityEntry } from "@pwragnt/shared";
import { TranscriptDiff } from "./TranscriptDiff";

type TranscriptActivityProps = {
  entry: AppServerThreadActivityEntry;
};

export function TranscriptActivity(props: TranscriptActivityProps) {
  const detailsId = useId();
  const [isExpanded, setIsExpanded] = useState(false);
  const hasDetails = props.entry.details.length > 0;
  const className =
    props.entry.tone === "warning"
      ? "transcript-activity transcript-activity--warning"
      : "transcript-activity";

  return (
    <aside className={className}>
      <header className="transcript-activity__header">
        {hasDetails ? (
          <button
            type="button"
            className="transcript-activity__toggle"
            aria-controls={detailsId}
            aria-expanded={isExpanded}
            onClick={() => {
              setIsExpanded((current) => !current);
            }}
          >
            <span className="transcript-activity__label">{props.entry.summary}</span>
            <span className="transcript-activity__meta">
              {props.entry.createdAt ? (
                <time className="transcript-activity__time">
                  {new Intl.DateTimeFormat(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit"
                  }).format(props.entry.createdAt)}
                </time>
              ) : null}
              <span className="transcript-activity__chevron" aria-hidden="true" />
            </span>
          </button>
        ) : (
          <>
            <span className="transcript-activity__label">{props.entry.summary}</span>
            {props.entry.createdAt ? (
              <time className="transcript-activity__time">
                {new Intl.DateTimeFormat(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit"
                }).format(props.entry.createdAt)}
              </time>
            ) : null}
          </>
        )}
      </header>

      {hasDetails && isExpanded ? (
        <ul id={detailsId} className="transcript-activity__details">
          {props.entry.details.map((detail) => (
            <li key={detail.id} className="transcript-activity__detail">
              {detail.url ? (
                <a
                  className="transcript-activity__detail-label"
                  href={detail.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {detail.label}
                </a>
              ) : (
                <span className="transcript-activity__detail-label">{detail.label}</span>
              )}
              {detail.fileDiff ? (
                <span className="transcript-activity__detail-stats" aria-label="File diff summary">
                  <span className="transcript-activity__detail-stat transcript-activity__detail-stat--removed">
                    -{detail.fileDiff.removals.toLocaleString()}
                  </span>
                  <span className="transcript-activity__detail-stat transcript-activity__detail-stat--added">
                    +{detail.fileDiff.additions.toLocaleString()}
                  </span>
                </span>
              ) : null}
              {detail.fileDiff ? <TranscriptDiff detail={detail} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </aside>
  );
}
