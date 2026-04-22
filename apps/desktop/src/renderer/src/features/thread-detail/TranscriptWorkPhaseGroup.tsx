import { memo, useId } from "react";
import type {
  AppServerSkillSummary,
  AppServerThreadEntry,
  AppServerThreadImagePart,
} from "@pwragnt/shared";
import { TranscriptActivity } from "./TranscriptActivity";
import { TranscriptMessage } from "./TranscriptMessage";
import { TranscriptPlan } from "./TranscriptPlan";

type TranscriptWorkPhaseGroupProps = {
  collapsible: boolean;
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
      {props.entries.map((entry) => renderEntry(entry, props.skills, props.onOpenImage))}
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

function renderEntry(
  entry: AppServerThreadEntry,
  skills: AppServerSkillSummary[],
  onOpenImage?: (image: AppServerThreadImagePart) => void
) {
  return entry.type === "activity" ? (
    <TranscriptActivity key={entry.id} entry={entry} />
  ) : entry.type === "plan" ? (
    <TranscriptPlan key={entry.id} entry={entry} />
  ) : (
    <TranscriptMessage
      key={entry.id}
      message={entry}
      skills={skills}
      onOpenImage={onOpenImage}
    />
  );
}
