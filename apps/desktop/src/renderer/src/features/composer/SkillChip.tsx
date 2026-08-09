import type { AppServerSkillSummary } from "@pwragent/shared";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { SkillIcon } from "../../icons";
import { buildSkillTooltip } from "../../lib/skill-mentions";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import {
  ChipContextMenu,
  type ChipContextMenuItem,
  type ChipContextMenuPosition,
} from "../chrome/ChipContextMenu";

type SkillChipProps = {
  editorName?: string;
  label?: string;
  onOpenInEditor?: (skill: SkillChipActionTarget) => void;
  onRemove?: () => void;
  onViewMarkdown?: (skill: SkillChipActionTarget) => void;
  skill: AppServerSkillSummary;
  target?: {
    column?: number;
    line?: number;
    path: string;
  };
  transcript?: boolean;
};

type SkillChipActionTarget = AppServerSkillSummary & {
  column?: number;
  line?: number;
  path: string;
};

export function SkillChip(props: SkillChipProps) {
  const contextMenuInvokerRef = useRef<HTMLSpanElement>(null);
  const [contextMenuPosition, setContextMenuPosition] =
    useState<ChipContextMenuPosition>();
  const tooltipController = useViewportTooltip({ className: "viewport-tooltip" });
  const path = props.skill.path?.trim();
  const actionTarget = path
    ? {
        ...props.skill,
        column: props.target?.column,
        line: props.target?.line,
        path: props.target?.path ?? path,
      }
    : undefined;
  const transcriptPath = props.transcript ? path : undefined;
  const isTranscriptSkill = Boolean(transcriptPath);
  const tooltip = transcriptPath
    ? buildTranscriptSkillTooltip(props.skill, transcriptPath)
    : buildSkillTooltip(props.skill);
  const updateTooltip = tooltipController.update;
  useEffect(() => {
    updateTooltip(tooltip);
  }, [tooltip, updateTooltip]);

  const handleActivate = (
    event: MouseEvent<HTMLSpanElement> | KeyboardEvent<HTMLSpanElement>,
  ): void => {
    if (!actionTarget || !props.onViewMarkdown) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    tooltipController.hide();
    props.onViewMarkdown(actionTarget);
  };

  const contextMenuItems = actionTarget
    ? skillContextMenuItems({
        editorName: props.editorName,
        onOpenInEditor: props.onOpenInEditor
          ? () => props.onOpenInEditor?.(actionTarget)
          : undefined,
        onViewMarkdown: props.onViewMarkdown
          ? () => props.onViewMarkdown?.(actionTarget)
          : undefined,
        path: actionTarget.path,
      })
    : [];

  return (
    <>
      <span
        aria-haspopup={isTranscriptSkill ? "menu" : undefined}
        aria-label={props.onViewMarkdown ? `View skill ${props.skill.name}` : undefined}
        className={[
          "chip",
          "skill-chip",
          isTranscriptSkill ? "skill-chip--transcript" : "tooltip-target",
          props.onRemove ? "skill-chip--removable" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        data-skill-chip={isTranscriptSkill ? "" : undefined}
        data-tooltip={!isTranscriptSkill ? tooltip || undefined : undefined}
        draggable={isTranscriptSkill ? false : undefined}
        role={props.onViewMarkdown ? "button" : undefined}
        tabIndex={tooltip && !props.onRemove ? 0 : -1}
        onBlur={isTranscriptSkill ? tooltipController.hide : undefined}
        onClick={props.onViewMarkdown ? handleActivate : undefined}
        onContextMenu={isTranscriptSkill ? (event) => {
          event.preventDefault();
          event.stopPropagation();
          window.getSelection()?.removeAllRanges();
          tooltipController.hide();
          const rect = event.currentTarget.getBoundingClientRect();
          contextMenuInvokerRef.current = event.currentTarget;
          setContextMenuPosition({
            x: event.clientX,
            y: event.clientY,
            anchorTop: rect.top,
          });
        } : undefined}
        onDragStart={isTranscriptSkill ? (event) => event.preventDefault() : undefined}
        onFocus={isTranscriptSkill
          ? (event) => tooltipController.show(event.currentTarget, tooltip)
          : undefined}
        onKeyDown={props.onViewMarkdown ? (event) => {
          if (event.key === "Enter" || event.key === " ") {
            handleActivate(event);
          }
        } : undefined}
        onMouseEnter={isTranscriptSkill
          ? (event) => tooltipController.show(event.currentTarget, tooltip)
          : undefined}
        onMouseLeave={isTranscriptSkill ? tooltipController.hide : undefined}
      >
        <span aria-hidden="true" className="thread-row__chip-icon">
          <SkillIcon size={12} />
        </span>
        <span className="skill-chip__label">
          {props.label ?? `$${props.skill.name}`}
        </span>
        {props.onRemove ? (
          <button
            aria-label={`Remove $${props.skill.name}`}
            className="skill-chip__remove"
            type="button"
            onClick={props.onRemove}
          >
            x
          </button>
        ) : null}
      </span>
      {isTranscriptSkill ? tooltipController.tooltipNode : null}
      {contextMenuPosition && contextMenuInvokerRef.current ? (
        <ChipContextMenu
          items={contextMenuItems}
          onClose={() => setContextMenuPosition(undefined)}
          position={contextMenuPosition}
          returnFocusTo={contextMenuInvokerRef.current}
        />
      ) : null}
    </>
  );
}

function skillContextMenuItems(options: {
  editorName?: string;
  onOpenInEditor?: () => void;
  onViewMarkdown?: () => void;
  path: string;
}): ChipContextMenuItem[] {
  const items: ChipContextMenuItem[] = [];
  if (options.onViewMarkdown) {
    items.push({
      action: options.onViewMarkdown,
      label: "View Skill Markdown",
    });
  }
  if (options.onOpenInEditor && options.editorName) {
    items.push({
      action: options.onOpenInEditor,
      label: `Open Skill Markdown in ${options.editorName}`,
    });
  }
  items.push({
    copyValue: options.path,
    label: "Copy Skill Path",
    separated: items.length > 0,
  });
  return items;
}

function buildTranscriptSkillTooltip(
  skill: AppServerSkillSummary,
  path: string,
): string {
  const description = skill.shortDescription?.trim() || skill.description?.trim();
  return [
    path,
    description,
    "Click to view markdown · Right-click for skill actions",
  ].filter(Boolean).join("\n");
}
