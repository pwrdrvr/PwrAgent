import { useId, useState } from "react";
import type { AppServerThreadActivityEntry } from "@pwragnt/shared";
import { TranscriptCommandOutput } from "./TranscriptCommandOutput";
import { TranscriptDiff } from "./TranscriptDiff";

type TranscriptActivityProps = {
  entry: AppServerThreadActivityEntry;
};

export function TranscriptActivity(props: TranscriptActivityProps) {
  const detailsId = useId();
  const [isExpanded, setIsExpanded] = useState(false);
  const [expandedDetailIds, setExpandedDetailIds] = useState(() => new Set<string>());
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
          {props.entry.details.map((detail) => {
            const nestedId = `${detailsId}-${detail.id}`;
            const hasNestedDetails = Boolean(detail.fileDiff || detail.command);
            const isDetailExpanded = expandedDetailIds.has(detail.id);
            const label = detail.url && !hasNestedDetails ? (
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
            );

            return (
              <li key={detail.id} className="transcript-activity__detail">
                <div className="transcript-activity__detail-row">
                  {hasNestedDetails ? (
                    <button
                      type="button"
                      className="transcript-activity__detail-toggle"
                      aria-controls={nestedId}
                      aria-expanded={isDetailExpanded}
                      onClick={() => {
                        setExpandedDetailIds((current) => {
                          const next = new Set(current);
                          if (next.has(detail.id)) {
                            next.delete(detail.id);
                          } else {
                            next.add(detail.id);
                          }
                          return next;
                        });
                      }}
                    >
                      <span className="transcript-activity__chevron" aria-hidden="true" />
                      {label}
                    </button>
                  ) : (
                    label
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
                </div>
                {hasNestedDetails && isDetailExpanded ? (
                  <div id={nestedId} className="transcript-activity__detail-body">
                    {detail.fileDiff ? <TranscriptDiff detail={detail} /> : null}
                    {detail.command ? <TranscriptCommandOutput detail={detail} /> : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </aside>
  );
}
