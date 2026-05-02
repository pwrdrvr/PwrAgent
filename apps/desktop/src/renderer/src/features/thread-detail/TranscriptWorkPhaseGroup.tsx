import { memo, useId } from "react";
import type {
  AppServerSkillSummary,
  AppServerThreadEntry,
  AppServerThreadImagePart,
  DesktopApplicationsSnapshot,
} from "@pwragnt/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { TranscriptActivity } from "./TranscriptActivity";
import { TranscriptMessage } from "./TranscriptMessage";
import { TranscriptPlan } from "./TranscriptPlan";
import { TranscriptReview } from "./TranscriptReview";

type TranscriptWorkPhaseGroupProps = {
  applications?: DesktopApplicationsSnapshot;
  collapsible: boolean;
  desktopApi?: Pick<DesktopApi, "openApplication">;
  entries: AppServerThreadEntry[];
  expanded: boolean;
  label: string;
  skills: AppServerSkillSummary[];
  onOpenImage?: (image: AppServerThreadImagePart) => void;
  onToggle: () => void;
};

export const TranscriptWorkPhaseGroup = memo(function TranscriptWorkPhaseGroup(
  props: TranscriptWorkPhaseGroupProps
) {
  const hiddenRegionId = useId();
  const content = (
    <div
      id={hiddenRegionId}
      className="transcript-work-phase-group__content"
      hidden={props.collapsible && !props.expanded}
    >
      {props.entries.map((entry) =>
        renderEntry({
          applications: props.applications,
          desktopApi: props.desktopApi,
          entry,
          onOpenImage: props.onOpenImage,
          skills: props.skills,
        })
      )}
    </div>
  );

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
          <span>{props.label}</span>
          <span className="transcript-work-phase-group__chevron" aria-hidden="true">
            {props.expanded ? "^" : "v"}
          </span>
        </button>
      ) : (
        <div className="transcript-work-phase-group__label">{props.label}</div>
      )}
      {content}
    </div>
  );
});

TranscriptWorkPhaseGroup.displayName = "TranscriptWorkPhaseGroup";

function renderEntry(params: {
  applications?: DesktopApplicationsSnapshot;
  desktopApi?: Pick<DesktopApi, "openApplication">;
  entry: AppServerThreadEntry;
  skills: AppServerSkillSummary[];
  onOpenImage?: (image: AppServerThreadImagePart) => void;
}) {
  const entry = params.entry;
  return entry.type === "activity" ? (
    <TranscriptActivity key={entry.id} entry={entry} />
  ) : entry.type === "plan" ? (
    <TranscriptPlan
      key={entry.id}
      applications={params.applications}
      desktopApi={params.desktopApi}
      entry={entry}
    />
  ) : entry.type === "review" ? (
    <TranscriptReview
      key={entry.id}
      applications={params.applications}
      desktopApi={params.desktopApi}
      entry={entry}
    />
  ) : (
    <TranscriptMessage
      key={entry.id}
      applications={params.applications}
      desktopApi={params.desktopApi}
      message={entry}
      skills={params.skills}
      onOpenImage={params.onOpenImage}
    />
  );
}
