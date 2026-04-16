import type { AppServerThreadMessage } from "@pwragnt/shared";
import { MarkdownText } from "./MarkdownText";

type TranscriptMessageProps = {
  message: AppServerThreadMessage;
};

export function TranscriptMessage(props: TranscriptMessageProps) {
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
      <MarkdownText className="transcript-message__text" text={props.message.text} />
    </article>
  );
}

function labelForRole(role: AppServerThreadMessage["role"]): string {
  if (role === "assistant") {
    return "Assistant";
  }
  return "User";
}
