import { memo, type ReactNode } from "react";
import type {
  AppServerSkillSummary,
  AppServerThreadImagePart,
  AppServerThreadMessageEntry,
  AppServerThreadMessagePart,
} from "@pwragnt/shared";
import { TranscriptImage } from "./TranscriptImage";
import { ThreadMarkdown } from "./ThreadMarkdown";

type TranscriptMessageProps = {
  message: AppServerThreadMessageEntry;
  skills: AppServerSkillSummary[];
  onOpenImage?: (image: AppServerThreadImagePart) => void;
};

export const TranscriptMessage = memo(function TranscriptMessage(props: TranscriptMessageProps) {
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
              skills: props.skills,
            })
          )}
        </div>
      ) : null}
    </article>
  );
});

TranscriptMessage.displayName = "TranscriptMessage";

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
  skills: AppServerSkillSummary[];
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
    <ThreadMarkdown
      key={`text:${params.index}`}
      className="transcript-message__text-block"
      skills={params.skills}
      text={params.segment.part.text}
    />
  );
}

function labelForRole(role: AppServerThreadMessageEntry["role"]): string {
  if (role === "assistant") {
    return "Assistant";
  }
  return "User";
}
