import { Fragment, type ReactNode } from "react";
import type {
  AppServerSkillSummary,
  AppServerThreadImagePart,
  AppServerThreadMessageEntry,
  AppServerThreadMessagePart,
} from "@pwragnt/shared";
import { SkillChip } from "../composer/SkillChip";
import { parseSkillMentionParts } from "../../lib/skill-mentions";
import { MarkdownText } from "./MarkdownText";

type TranscriptMessageProps = {
  message: AppServerThreadMessageEntry;
  skills: AppServerSkillSummary[];
  onOpenImage?: (image: AppServerThreadImagePart) => void;
};

export function TranscriptMessage(props: TranscriptMessageProps) {
  const skillsByPath = new Map(
    props.skills
      .filter(
        (skill): skill is AppServerSkillSummary & { path: string } => Boolean(skill.path)
      )
      .map((skill) => [skill.path, skill])
  );
  const contentParts =
    props.message.parts && props.message.parts.length > 0
      ? props.message.parts
      : props.message.text
        ? [{ type: "text", text: props.message.text } satisfies AppServerThreadMessagePart]
        : [];

  return (
    <article
      className={`transcript-message transcript-message--${props.message.role}`}
    >
      <header className="transcript-message__header">
        <span className="transcript-message__role">{labelForRole(props.message.role)}</span>
        {props.message.createdAt ? (
          <time className="transcript-message__time">
            {new Intl.DateTimeFormat(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit"
            }).format(props.message.createdAt)}
          </time>
        ) : null}
      </header>
      {contentParts.length > 0 ? (
        <div className="transcript-message__text">
          {contentParts.map((part, index) =>
            renderMessagePart({
              part,
              index,
              onOpenImage: props.onOpenImage,
              skillsByPath
            })
          )}
        </div>
      ) : null}
    </article>
  );
}

function renderMessagePart(params: {
  part: AppServerThreadMessagePart;
  index: number;
  onOpenImage?: (image: AppServerThreadImagePart) => void;
  skillsByPath: Map<string, AppServerSkillSummary & { path: string }>;
}): ReactNode {
  if (params.part.type === "image") {
    const imagePart = params.part;
    return (
      <button
        key={`image:${params.index}`}
        type="button"
        className="transcript-message__image-button"
        aria-label={`Expand transcript image ${params.index + 1}`}
        onClick={() => {
          params.onOpenImage?.(imagePart);
        }}
      >
        <img
          className="transcript-message__image-preview"
          src={imagePart.url}
          alt={imagePart.alt ?? "Transcript image"}
          loading="lazy"
        />
      </button>
    );
  }

  return (
    <Fragment key={`text:${params.index}`}>
      {renderTextPart(params.part.text, `part-${params.index}`, params.skillsByPath)}
    </Fragment>
  );
}

function renderTextPart(
  text: string,
  keyPrefix: string,
  skillsByPath: Map<string, AppServerSkillSummary & { path: string }>
): ReactNode {
  const parts = parseSkillMentionParts(text);
  const hasSkillMention = parts.some((part) => part.type === "skill");

  if (!hasSkillMention) {
    return <MarkdownText className="transcript-message__text-block" text={text} />;
  }

  return (
    <div className="transcript-message__text-block">
      {parts.map((part, index) => {
        if (part.type === "text") {
          return (
            <span key={`${keyPrefix}:text:${index}`} className="transcript-message__text-part">
              {part.text}
            </span>
          );
        }

        return (
          <SkillChip
            key={`${keyPrefix}:skill:${part.path}:${index}`}
            label={part.label}
            skill={
              skillsByPath.get(part.path) ?? {
                name: part.name,
                path: part.path,
              }
            }
          />
        );
      })}
    </div>
  );
}

function labelForRole(role: AppServerThreadMessageEntry["role"]): string {
  if (role === "assistant") {
    return "Assistant";
  }
  return "User";
}
