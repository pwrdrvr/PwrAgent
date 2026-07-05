import { memo, useEffect, useId, useState } from "react";
import type {
  AppServerSkillSummary,
  AppServerThreadEntry,
  AppServerThreadImagePart,
  DesktopApplicationsSnapshot,
  MarkdownFileViewerContext,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { TranscriptActivity } from "./TranscriptActivity";
import { TranscriptMessage } from "./TranscriptMessage";
import { TranscriptPlan } from "./TranscriptPlan";
import { TranscriptReview } from "./TranscriptReview";
import { formatElapsedMs } from "./transcript-render-items";

type TranscriptWorkPhaseGroupProps = {
  activeStartedAt?: number;
  applications?: DesktopApplicationsSnapshot;
  collapsible: boolean;
  directoryPaths?: string[];
  desktopApi?: Pick<
    DesktopApi,
    | "copyText"
    | "openApplication"
    | "openMarkdownFileViewer"
    | "readMarkdownFile"
  >;
  entries: AppServerThreadEntry[];
  expanded: boolean;
  fileViewerContext?: MarkdownFileViewerContext;
  label: string;
  skills: AppServerSkillSummary[];
  onOpenImage?: (image: AppServerThreadImagePart) => void;
  onToggle: () => void;
};

export const TranscriptWorkPhaseGroup = memo(function TranscriptWorkPhaseGroup(
  props: TranscriptWorkPhaseGroupProps,
) {
  const hiddenRegionId = useId();
  const shouldRenderContent = !props.collapsible || props.expanded;

  return (
    <div className="transcript-work-phase-group">
      {props.collapsible ? (
        <button
          type="button"
          className="transcript-work-phase-group__toggle"
          aria-controls={hiddenRegionId}
          aria-expanded={props.expanded}
          onClick={props.onToggle}
        >
          <span
            className="transcript-work-phase-group__chevron"
            aria-hidden="true"
          />
          <span>
            <TranscriptWorkPhaseGroupLabel
              activeStartedAt={props.activeStartedAt}
              label={props.label}
            />
          </span>
        </button>
      ) : (
        <div className="transcript-work-phase-group__label">
          <TranscriptWorkPhaseGroupLabel
            activeStartedAt={props.activeStartedAt}
            label={props.label}
          />
        </div>
      )}
      {shouldRenderContent ? (
        <div
          id={hiddenRegionId}
          className="transcript-work-phase-group__content"
        >
          {props.entries.map((entry) =>
            renderEntry({
              applications: props.applications,
              directoryPaths: props.directoryPaths,
              desktopApi: props.desktopApi,
              entry,
              fileViewerContext: props.fileViewerContext,
              onOpenImage: props.onOpenImage,
              skills: props.skills,
            }),
          )}
        </div>
      ) : null}
    </div>
  );
});

TranscriptWorkPhaseGroup.displayName = "TranscriptWorkPhaseGroup";

function TranscriptWorkPhaseGroupLabel(props: {
  activeStartedAt?: number;
  label: string;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (typeof props.activeStartedAt !== "number") {
      return undefined;
    }

    setNow(Date.now());
    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(interval);
    };
  }, [props.activeStartedAt]);

  if (typeof props.activeStartedAt !== "number") {
    return props.label;
  }

  return `Working for ${formatElapsedMs(now - props.activeStartedAt)}`;
}

function renderEntry(params: {
  applications?: DesktopApplicationsSnapshot;
  directoryPaths?: string[];
  desktopApi?: Pick<
    DesktopApi,
    | "copyText"
    | "openApplication"
    | "openMarkdownFileViewer"
    | "readMarkdownFile"
  >;
  entry: AppServerThreadEntry;
  fileViewerContext?: MarkdownFileViewerContext;
  skills: AppServerSkillSummary[];
  onOpenImage?: (image: AppServerThreadImagePart) => void;
}) {
  const entry = params.entry;
  return entry.type === "activity" ? (
    <TranscriptActivity
      key={entry.id}
      applications={params.applications}
      desktopApi={params.desktopApi}
      entry={entry}
      fileViewerContext={params.fileViewerContext}
      skills={params.skills}
    />
  ) : entry.type === "plan" ? (
    <TranscriptPlan
      key={entry.id}
      applications={params.applications}
      desktopApi={params.desktopApi}
      entry={entry}
      fileViewerContext={params.fileViewerContext}
    />
  ) : entry.type === "review" ? (
    <TranscriptReview
      key={entry.id}
      applications={params.applications}
      directoryPaths={params.directoryPaths}
      desktopApi={params.desktopApi}
      entry={entry}
      fileViewerContext={params.fileViewerContext}
    />
  ) : (
    <TranscriptMessage
      key={entry.id}
      applications={params.applications}
      desktopApi={params.desktopApi}
      fileViewerContext={params.fileViewerContext}
      message={entry}
      skills={params.skills}
      onOpenImage={params.onOpenImage}
    />
  );
}
