import { memo, useId } from "react";
import type {
  AppServerSkillSummary,
  AppServerThreadImagePart,
  AppServerThreadMessageEntry,
} from "@pwragnt/shared";
import { TranscriptMessage } from "./TranscriptMessage";

type TranscriptCommentaryGroupProps = {
  expanded: boolean;
  hiddenMessages: AppServerThreadMessageEntry[];
  skills: AppServerSkillSummary[];
  onOpenImage?: (image: AppServerThreadImagePart) => void;
  onToggle: () => void;
};

export const TranscriptCommentaryGroup = memo(function TranscriptCommentaryGroup(
  props: TranscriptCommentaryGroupProps
) {
  const hiddenRegionId = useId();
  const hiddenCount = props.hiddenMessages.length;
  const label = `${hiddenCount} previous ${hiddenCount === 1 ? "message" : "messages"}`;

  return (
    <div className="transcript-commentary-group">
      <button
        type="button"
        className="transcript-commentary-group__toggle"
        aria-controls={hiddenRegionId}
        aria-expanded={props.expanded}
        onClick={props.onToggle}
      >
        <span>{label}</span>
        <span className="transcript-commentary-group__chevron" aria-hidden="true">
          {props.expanded ? "^" : "v"}
        </span>
      </button>
      <div
        id={hiddenRegionId}
        className="transcript-commentary-group__hidden"
        hidden={!props.expanded}
      >
        {props.hiddenMessages.map((message) => (
          <TranscriptMessage
            key={message.id}
            message={message}
            skills={props.skills}
            onOpenImage={props.onOpenImage}
          />
        ))}
      </div>
    </div>
  );
});

TranscriptCommentaryGroup.displayName = "TranscriptCommentaryGroup";
