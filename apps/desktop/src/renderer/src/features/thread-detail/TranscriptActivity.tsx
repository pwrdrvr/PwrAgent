import { useId, useState } from "react";
import type {
  AppServerSkillSummary,
  AppServerThreadActivityEntry,
  AppServerThreadImagePart,
  DesktopApplicationsSnapshot,
  MarkdownFileViewerContext,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import type { ThreadLinkSource } from "../../lib/thread-links";
import { formatActivityText } from "./activity-path-display";
import { ThreadMarkdown } from "./ThreadMarkdown";
import {
  isThreadReferenceToolDetail,
  TranscriptCommandOutput,
  TranscriptThreadToolActivity,
} from "./TranscriptCommandOutput";
import { TranscriptCopyButton } from "./TranscriptCopyButton";
import { TranscriptDiff } from "./TranscriptDiff";
import { TranscriptImage } from "./TranscriptImage";

type TranscriptActivityProps = {
  applications?: DesktopApplicationsSnapshot;
  desktopApi?: Pick<
    DesktopApi,
    "copyText" | "openApplication" | "openMarkdownFileViewer" | "readMarkdownFile"
  >;
  directoryPaths?: string[];
  entry: AppServerThreadActivityEntry;
  expanded?: boolean;
  fileViewerContext?: MarkdownFileViewerContext;
  onOpenImage?: (image: AppServerThreadImagePart) => void;
  onExpandedChange?: (expanded: boolean) => void;
  skills?: AppServerSkillSummary[];
  threadLinkSource?: ThreadLinkSource;
};

export function TranscriptActivity(props: TranscriptActivityProps) {
  const detailsId = useId();
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(false);
  const isExpanded = props.expanded ?? uncontrolledExpanded;
  const [expandedDetailIds, setExpandedDetailIds] = useState(() => new Set<string>());
  const hasDetails = props.entry.details.length > 0;
  const directDetail = singleDirectDetail(props.entry);
  const images = props.entry.details.flatMap((detail) => detail.images ?? []);
  const activityCopyText = buildActivityCopyText(props.entry);
  const displaySummary = formatActivityText(
    props.entry.summary,
    props.entry.details,
    props.directoryPaths,
  );
  const className =
    props.entry.tone === "warning"
      ? "transcript-activity transcript-activity--warning"
      : "transcript-activity";

  if (directDetail && isThreadReferenceToolDetail(directDetail)) {
    return (
      <TranscriptThreadToolActivity
        applications={props.applications}
        createdAt={props.entry.createdAt}
        desktopApi={props.desktopApi}
        detail={directDetail}
        expanded={isExpanded}
        fileViewerContext={props.fileViewerContext}
        skills={props.skills}
        threadLinkSource={props.threadLinkSource}
        onExpandedChange={(expanded) => {
          if (props.expanded !== undefined) {
            props.onExpandedChange?.(expanded);
            return;
          }
          setUncontrolledExpanded(expanded);
        }}
      />
    );
  }

  return (
    <aside className={className}>
      <header className="transcript-activity__header">
        {hasDetails ? (
          <>
            <button
              type="button"
              className="transcript-activity__toggle"
              aria-controls={detailsId}
              aria-expanded={isExpanded}
              onClick={() => {
                const nextExpanded = !isExpanded;
                if (props.expanded !== undefined) {
                  props.onExpandedChange?.(nextExpanded);
                  return;
                }
                setUncontrolledExpanded(nextExpanded);
              }}
            >
              <span className="transcript-activity__chevron" aria-hidden="true" />
              <span className="transcript-activity__label">{displaySummary}</span>
            </button>
            <span className="transcript-activity__header-actions">
              <TranscriptCopyButton
                className="transcript-copy-button--activity"
                copiedLabel="Copied activity"
                desktopApi={props.desktopApi}
                label="Copy activity"
                text={activityCopyText}
              />
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
            </span>
          </>
        ) : (
          <>
            <span className="transcript-activity__label">{displaySummary}</span>
            <span className="transcript-activity__header-actions">
              <TranscriptCopyButton
                className="transcript-copy-button--activity"
                copiedLabel="Copied activity"
                desktopApi={props.desktopApi}
                label="Copy activity"
                text={activityCopyText}
              />
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
            </span>
          </>
        )}
      </header>

      {images.length > 0 ? (
        <div className="transcript-activity__images">
          {images.map((image, index) => (
            <button
              key={`${index}:${image.url.slice(0, 80)}`}
              type="button"
              className="transcript-activity__image-button"
              aria-label={`Expand tool result image ${index + 1}`}
              onClick={() => {
                props.onOpenImage?.(image);
              }}
            >
              <TranscriptImage
                className="transcript-activity__image"
                src={image.url}
                alt={image.alt ?? "Tool result"}
                loading="lazy"
              />
            </button>
          ))}
        </div>
      ) : null}

      {directDetail && isExpanded ? (
        <div id={detailsId} className="transcript-activity__detail-body">
          <TranscriptCommandOutput
            applications={props.applications}
            desktopApi={props.desktopApi}
            detail={directDetail}
            directoryPaths={props.directoryPaths}
            fileViewerContext={props.fileViewerContext}
            skills={props.skills}
            threadLinkSource={props.threadLinkSource}
          />
        </div>
      ) : hasDetails && isExpanded ? (
        <ul id={detailsId} className="transcript-activity__details">
          {props.entry.details.map((detail) => {
            const nestedId = `${detailsId}-${detail.id}`;
            const hasNestedDetails = Boolean(detail.fileDiff || detail.command);
            const isDetailExpanded = expandedDetailIds.has(detail.id);
            const markdown = detail.markdown?.trim();
            const displayLabel = formatActivityText(
              detail.label,
              [detail],
              props.directoryPaths,
            );
            const markdownContent =
              markdown && !hasNestedDetails ? (
                <ThreadMarkdown
                  applications={props.applications}
                  className="transcript-activity__detail-markdown"
                  desktopApi={props.desktopApi}
                  fileViewerContext={props.fileViewerContext}
                  skills={props.skills}
                  text={markdown}
                  threadLinkSource={props.threadLinkSource}
                  variant="summary"
                />
              ) : null;
            const label = detail.url && !hasNestedDetails ? (
              <a
                className="transcript-activity__detail-label"
                href={detail.url}
                target="_blank"
                rel="noreferrer"
              >
                {displayLabel}
              </a>
            ) : (
              <span className="transcript-activity__detail-label">{displayLabel}</span>
            );

            return (
              <li key={detail.id} className="transcript-activity__detail">
                {markdownContent && !detail.fileDiff && !detail.status ? (
                  markdownContent
                ) : (
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
                      markdownContent ?? label
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
                    {detail.status ? (
                      <span
                        className={[
                          "transcript-activity__detail-status",
                          `transcript-activity__detail-status--${detail.status}`
                        ].join(" ")}
                      >
                        {formatActivityDetailStatus(detail.status)}
                      </span>
                    ) : null}
                  </div>
                )}
                {hasNestedDetails && isDetailExpanded ? (
                  <div id={nestedId} className="transcript-activity__detail-body">
                    {detail.fileDiff ? <TranscriptDiff detail={detail} /> : null}
                    {detail.command ? (
                      <TranscriptCommandOutput
                        applications={props.applications}
                        desktopApi={props.desktopApi}
                        detail={detail}
                        directoryPaths={props.directoryPaths}
                        fileViewerContext={props.fileViewerContext}
                        skills={props.skills}
                        threadLinkSource={props.threadLinkSource}
                      />
                    ) : null}
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

function singleDirectDetail(
  entry: AppServerThreadActivityEntry,
): AppServerThreadActivityEntry["details"][number] | undefined {
  const detail = entry.details.length === 1 ? entry.details[0] : undefined;
  if (
    !detail?.command ||
    detail.fileDiff ||
    detail.markdown ||
    detail.url ||
    detail.label.trim().toLowerCase() !== entry.summary.trim().toLowerCase()
  ) {
    return undefined;
  }
  return detail;
}

function buildActivityCopyText(entry: AppServerThreadActivityEntry): string {
  return [entry.summary, ...entry.details.map((detail) => detail.label)]
    .filter((text) => text.trim().length > 0)
    .join("\n");
}

function formatActivityDetailStatus(
  status: NonNullable<AppServerThreadActivityEntry["status"]>
): string {
  if (status === "in_progress") {
    return "Running";
  }
  if (status === "completed") {
    return "Done";
  }
  return status[0]?.toUpperCase() ? `${status[0].toUpperCase()}${status.slice(1)}` : status;
}
