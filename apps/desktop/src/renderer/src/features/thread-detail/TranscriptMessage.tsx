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
import { TranscriptImage } from "./TranscriptImage";

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
          {groupMessageParts(contentParts).map((segment, index) =>
            renderMessageSegment({
              segment,
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

type MessagePartSegment =
  | { type: "text"; part: Exclude<AppServerThreadMessagePart, AppServerThreadImagePart> }
  | { type: "images"; parts: AppServerThreadImagePart[]; startIndex: number };

function groupMessageParts(parts: AppServerThreadMessagePart[]): MessagePartSegment[] {
  const segments: MessagePartSegment[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.type === "image") {
      const existingSegment = segments[segments.length - 1];
      if (existingSegment?.type === "images") {
        existingSegment.parts.push(part);
        continue;
      }

      segments.push({
        type: "images",
        parts: [part],
        startIndex: index
      });
      continue;
    }

    segments.push({
      type: "text",
      part
    });
  }

  return segments;
}

function renderMessageSegment(params: {
  segment: MessagePartSegment;
  index: number;
  onOpenImage?: (image: AppServerThreadImagePart) => void;
  skillsByPath: Map<string, AppServerSkillSummary & { path: string }>;
}): ReactNode {
  if (params.segment.type === "images") {
    const imageSegment = params.segment;

    return (
      <div key={`images:${params.index}`} className="transcript-message__image-grid">
        {imageSegment.parts.map((imagePart, imageIndex) => (
          <button
            key={`image:${imageSegment.startIndex + imageIndex}`}
            type="button"
            className="transcript-message__image-button"
            aria-label={`Expand transcript image ${imageSegment.startIndex + imageIndex + 1}`}
            onClick={() => {
              params.onOpenImage?.(imagePart);
            }}
          >
            <TranscriptImage
              className="transcript-message__image-preview"
              src={imagePart.url}
              alt={imagePart.alt ?? "Transcript image"}
              loading="lazy"
            />
          </button>
        ))}
      </div>
    );
  }

  return (
    <Fragment key={`text:${params.index}`}>
      {renderTextPart(params.segment.part.text, `part-${params.index}`, params.skillsByPath)}
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
