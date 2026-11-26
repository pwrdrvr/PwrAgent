import { memo, useId, useState } from "react";
import { useTranscriptActivityDetails } from "../../lib/useTranscriptActivityDetails";
import { transcriptImageUnavailableReason } from "@pwragent/shared/transcript-image-sources";
import type {
  AppServerSkillSummary,
  AppServerThreadActivityDetail,
  AppServerThreadActivityEntry,
  AppServerThreadImagePart,
} from "@pwragent/shared/contracts/normalized-app-server";
import type {
  DesktopApplicationsSnapshot,
  MarkdownFileViewerContext,
} from "@pwragent/shared/contracts/settings";
import type { DesktopApi } from "../../lib/desktop-api";
import type { ThreadLinkSource } from "../../lib/thread-links";
import { formatBrowserUrlDisplay } from "@pwragent/shared/codex-browser-use";
import { formatActivityText } from "./activity-path-display";
import { buildBrowserUsePresentation } from "./codex-browser-completion";
import { ThreadMarkdown } from "./ThreadMarkdown";
import {
  buildBrowserUseCopyText,
  TranscriptBrowserUseActivity,
} from "./TranscriptBrowserUseActivity";
import {
  describePullRequestWatchTool,
  isThreadReferenceToolDetail,
  TranscriptCommandOutput,
  TranscriptPullRequestWatchActivity,
  TranscriptThreadToolActivity,
} from "./TranscriptCommandOutput";
import { TranscriptCopyButton } from "./TranscriptCopyButton";
import { TranscriptDiff } from "./TranscriptDiff";
import { TranscriptImage } from "./TranscriptImage";

type TranscriptActivityProps = {
  applications?: DesktopApplicationsSnapshot;
  desktopApi?: Pick<
    DesktopApi,
    "copyText" | "openApplication" | "openMarkdownFileViewer" | "readMarkdownFile" | "readThread"
  >;
  directoryPaths?: string[];
  entry: AppServerThreadActivityEntry;
  expanded?: boolean;
  fileViewerContext?: MarkdownFileViewerContext;
  onOpenImage?: (image: AppServerThreadImagePart) => void;
  onExpandedChange?: (activityId: string, expanded: boolean) => void;
  skills?: AppServerSkillSummary[];
  threadLinkSource?: ThreadLinkSource;
};

export const TranscriptActivity = memo(function TranscriptActivity(props: TranscriptActivityProps) {
  const detailsId = useId();
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(false);
  const isExpanded = props.expanded ?? uncontrolledExpanded;
  const details = useTranscriptActivityDetails({ entry: props.entry, expanded: isExpanded, desktopApi: props.desktopApi, instanceId: props.threadLinkSource?.instanceId });
  const entry = details.entry;
  const hasDetails = Boolean(entry.detailsRef)
    || (entry.details.length > 0 && !hasOnlyRepeatedLabel(entry));
  const directDetail = singleDirectDetail(entry);
  const images = entry.details.flatMap((detail) => detail.images ?? []);
  const activityCopyText = buildActivityCopyText(entry);
  const displaySummary = formatActivityText(
    entry.summary,
    entry.details,
    props.directoryPaths,
  );
  const className =
    entry.tone === "warning"
      ? "transcript-activity transcript-activity--warning"
      : "transcript-activity";

  const prWatch = directDetail && !entry.detailsRef
    ? describePullRequestWatchTool(directDetail)
    : undefined;
  if (directDetail && prWatch) {
    return (
      <TranscriptPullRequestWatchActivity
        createdAt={entry.createdAt}
        detail={directDetail}
        expanded={isExpanded}
        presentation={prWatch}
        onExpandedChange={(expanded) => {
          if (props.expanded !== undefined) {
            props.onExpandedChange?.(entry.id, expanded);
            return;
          }
          setUncontrolledExpanded(expanded);
        }}
      />
    );
  }

  if (directDetail && !entry.detailsRef && isThreadReferenceToolDetail(directDetail)) {
    return (
      <TranscriptThreadToolActivity
        applications={props.applications}
        createdAt={entry.createdAt}
        desktopApi={props.desktopApi}
        detail={directDetail}
        expanded={isExpanded}
        fileViewerContext={props.fileViewerContext}
        skills={props.skills}
        threadLinkSource={props.threadLinkSource}
        onExpandedChange={(expanded) => {
          if (props.expanded !== undefined) {
            props.onExpandedChange?.(entry.id, expanded);
            return;
          }
          setUncontrolledExpanded(expanded);
        }}
      />
    );
  }

  const toggleExpanded = (): void => {
    const nextExpanded = !isExpanded;
    if (props.expanded !== undefined) {
      props.onExpandedChange?.(entry.id, nextExpanded);
      return;
    }
    setUncontrolledExpanded(nextExpanded);
  };

  const browserUse = entry.browserUse ?? buildBrowserUsePresentation(entry);
  if (browserUse) {
    return (
      <TranscriptBrowserUseActivity
        browserUse={browserUse}
        copyText={buildBrowserUseCopyText(entry, browserUse)}
        desktopApi={props.desktopApi}
        detailsContent={renderActivityDetails({
          details,
          detailsId,
          directDetail,
          entry,
          hasDetails,
          isExpanded,
          props,
        })}
        detailsId={detailsId}
        displaySummary={displaySummary}
        entry={entry}
        hasDetails={hasDetails}
        imagesContent={renderActivityImages(images, props.onOpenImage)}
        isExpanded={isExpanded}
        onOpenImage={props.onOpenImage}
        onToggleExpanded={toggleExpanded}
      />
    );
  }

  return (
    <aside
      className={className}
      data-expanded={hasDetails && isExpanded ? "true" : undefined}
    >
      <header className="transcript-activity__header">
        {hasDetails ? (
          <>
            <button
              type="button"
              className="transcript-activity__toggle"
              aria-controls={detailsId}
              aria-expanded={isExpanded}
              onClick={toggleExpanded}
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
              {entry.createdAt ? (
                <time className="transcript-activity__time tooltip-target" dateTime={new Date(entry.createdAt).toISOString()} data-tooltip={new Date(entry.createdAt).toISOString()}>
                  {new Intl.DateTimeFormat(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit"
                  }).format(entry.createdAt)}
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
              {entry.createdAt ? (
                <time className="transcript-activity__time tooltip-target" dateTime={new Date(entry.createdAt).toISOString()} data-tooltip={new Date(entry.createdAt).toISOString()}>
                  {new Intl.DateTimeFormat(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit"
                  }).format(entry.createdAt)}
                </time>
              ) : null}
            </span>
          </>
        )}
      </header>

      {renderActivityImages(images, props.onOpenImage)}
      {renderActivityDetails({
        details,
        detailsId,
        directDetail,
        entry,
        hasDetails,
        isExpanded,
        props,
      })}
    </aside>
  );
});

function renderActivityImages(
  images: AppServerThreadImagePart[],
  onOpenImage: TranscriptActivityProps["onOpenImage"],
) {
  if (images.length === 0) return null;
  return (
    <div className="transcript-activity__images">
      {images.map((image, index) => transcriptImageUnavailableReason(image) ? (
        <div key={`${index}:${image.url.slice(0, 80)}`} className="transcript-message__image-fallback">
          <div className="transcript-message__image-fallback-main">
            <span className="transcript-message__image-fallback-title">
              {transcriptImageUnavailableReason(image)}
            </span>
          </div>
        </div>
      ) : (
        <button
          key={`${index}:${image.url.slice(0, 80)}`}
          type="button"
          className="transcript-activity__image-button"
          aria-label={`Expand tool result image ${index + 1}`}
          onClick={() => {
            onOpenImage?.(image);
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
  );
}

function renderActivityDetails(params: {
  details: ReturnType<typeof useTranscriptActivityDetails>;
  detailsId: string;
  directDetail: AppServerThreadActivityDetail | undefined;
  entry: AppServerThreadActivityEntry;
  hasDetails: boolean;
  isExpanded: boolean;
  props: TranscriptActivityProps;
}) {
  const { details, detailsId, directDetail, entry, hasDetails, isExpanded, props } = params;
  if (isExpanded && details.error) {
    return (
      <div id={detailsId} className="transcript-activity__detail-body" role="alert">
        {details.error}{" "}
        <button
          type="button"
          className="transcript-activity__detail-toggle"
          onClick={() => {
            void details.load().catch(() => undefined);
          }}
        >
          Retry
        </button>
      </div>
    );
  }
  if (isExpanded && entry.detailsRef) {
    return (
      <div id={detailsId} className="transcript-activity__detail-body" role="status">
        Loading activity details…
      </div>
    );
  }
  if (hasDetails && directDetail && isExpanded) {
    return (
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
    );
  }
  if (hasDetails && isExpanded) {
    return (
      <ul id={detailsId} className="transcript-activity__details">
        {entry.details.map((detail) => (
          <TranscriptActivityDetailRow
            key={detail.id}
            applications={props.applications}
            desktopApi={props.desktopApi}
            detail={detail}
            directoryPaths={props.directoryPaths}
            fileViewerContext={props.fileViewerContext}
            skills={props.skills}
            threadLinkSource={props.threadLinkSource}
          />
        ))}
      </ul>
    );
  }
  return null;
}

type TranscriptActivityRunProps = Omit<
  TranscriptActivityProps,
  "entry" | "expanded" | "onExpandedChange" | "onOpenImage"
> & {
  entries: AppServerThreadActivityEntry[];
};

/**
 * A run of one-call activities inside a work group, drawn as the rows of one
 * batched activity. A model that makes one tool call per step otherwise
 * stacks a collapsible header per call, each hiding a single row, under a
 * group toggle that already folds them all.
 */
export const TranscriptActivityRun = memo(function TranscriptActivityRun(
  props: TranscriptActivityRunProps,
) {
  return (
    <aside className="transcript-activity transcript-activity--run">
      <ul className="transcript-activity__details">
        {props.entries.flatMap((entry) =>
          entry.details.map((detail) => (
            <TranscriptActivityDetailRow
              key={`${entry.id}:${detail.id}`}
              applications={props.applications}
              desktopApi={props.desktopApi}
              detail={detail}
              directoryPaths={props.directoryPaths}
              fileViewerContext={props.fileViewerContext}
              skills={props.skills}
              threadLinkSource={props.threadLinkSource}
            />
          ))
        )}
      </ul>
    </aside>
  );
});

TranscriptActivityRun.displayName = "TranscriptActivityRun";

function TranscriptActivityDetailRow(props: {
  applications?: DesktopApplicationsSnapshot;
  desktopApi?: TranscriptActivityProps["desktopApi"];
  detail: AppServerThreadActivityDetail;
  directoryPaths?: string[];
  fileViewerContext?: MarkdownFileViewerContext;
  skills?: AppServerSkillSummary[];
  threadLinkSource?: ThreadLinkSource;
}) {
  const nestedId = useId();
  const [isDetailExpanded, setDetailExpanded] = useState(false);
  const detail = props.detail;
  const hasNestedDetails = Boolean(detail.fileDiff || detail.command);
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
    <li
      className="transcript-activity__detail"
      data-expanded={hasNestedDetails && isDetailExpanded ? "true" : undefined}
    >
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
                setDetailExpanded((current) => !current);
              }}
            >
              <span className="transcript-activity__chevron" aria-hidden="true" />
              {label}
            </button>
          ) : (
            markdownContent ?? label
          )}
          {detail.browserUse?.url && /^https?:\/\//i.test(detail.browserUse.url)
            && !displayLabel.includes(formatBrowserUrlDisplay(detail.browserUse.url)) ? (
            <a
              className="transcript-browser-use__detail-url"
              href={detail.browserUse.url}
              target="_blank"
              rel="noreferrer"
              title={detail.browserUse.url}
            >
              {formatBrowserUrlDisplay(detail.browserUse.url)}
            </a>
          ) : null}
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
}

function hasOnlyRepeatedLabel(entry: AppServerThreadActivityEntry): boolean {
  const detail = entry.details.length === 1 ? entry.details[0] : undefined;
  if (!detail || detail.label.trim() !== entry.summary.trim()) {
    return false;
  }
  const command = detail.command;
  const hasCommandDetails = command && (
    command.source !== "tool"
    || command.displayCommand.trim() !== detail.label.trim()
    || command.rawCommand !== undefined
    || command.output !== undefined
    || command.exitCode !== undefined
    || command.durationMs !== undefined
    || command.cwd !== undefined
    || command.subAgent !== undefined
  );
  const isPathOnlyEdit = detail.kind === "write"
    && (detail.status === undefined || detail.status === "completed");
  return !hasCommandDetails
    && !detail.browserUse
    && !detail.fileDiff
    && !detail.markdown
    && !detail.url
    && (!detail.path || isPathOnlyEdit)
    && !detail.images?.length
    && (!detail.status || isPathOnlyEdit);
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
