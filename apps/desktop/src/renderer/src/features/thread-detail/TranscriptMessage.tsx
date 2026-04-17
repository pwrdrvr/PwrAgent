import type {
  AppServerSkillSummary,
  AppServerThreadMessageEntry,
} from "@pwragnt/shared";
import { SkillChip } from "../composer/SkillChip";
import { parseSkillMentionParts } from "../../lib/skill-mentions";
import { MarkdownText } from "./MarkdownText";

type TranscriptMessageProps = {
  message: AppServerThreadMessageEntry;
  skills: AppServerSkillSummary[];
};

export function TranscriptMessage(props: TranscriptMessageProps) {
  const parts = parseSkillMentionParts(props.message.text);
  const hasSkillMention = parts.some((part) => part.type === "skill");
  const skillsByPath = new Map(
    props.skills
      .filter(
        (skill): skill is AppServerSkillSummary & { path: string } => Boolean(skill.path)
      )
      .map((skill) => [skill.path, skill])
  );

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
      {hasSkillMention ? (
        <div className="transcript-message__text">
          {parts.map((part, index) => {
            if (part.type === "text") {
              return (
                <span key={`text:${index}`} className="transcript-message__text-part">
                  {part.text}
                </span>
              );
            }

            return (
              <SkillChip
                key={`skill:${part.path}:${index}`}
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
      ) : (
        <MarkdownText className="transcript-message__text" text={props.message.text} />
      )}
    </article>
  );
}

function labelForRole(role: AppServerThreadMessageEntry["role"]): string {
  if (role === "assistant") {
    return "Assistant";
  }
  return "User";
}
