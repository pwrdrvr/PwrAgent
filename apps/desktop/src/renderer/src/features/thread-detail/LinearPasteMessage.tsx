import type { ReactNode } from "react";
import type { LinearPasteLayout, LinearPastePiece } from "@pwragent/shared";

/**
 * Text the operator pasted from Linear, shown as Linear showed it: the
 * issue's identifier and title over its team, project and labels, then the
 * description as Markdown, with each `<linear-image>` as a named chip. The
 * images themselves, when the paste attached them, are the message's own
 * image tiles. The message text, and what Copy copies, stay the original
 * prompt.
 */
export function LinearPasteMessage(props: {
  layout: LinearPasteLayout;
  renderMarkdown: (text: string, key: string) => ReactNode;
}): ReactNode {
  const { before, issue, body, after } = props.layout;
  const pieces = body.map((piece, index) => renderPiece(piece, index, props.renderMarkdown));
  const details = issue
    ? [issue.team, issue.project, ...issue.labels].filter((value): value is string =>
        Boolean(value)
      )
    : [];
  return (
    <div className="linear-paste">
      {before ? props.renderMarkdown(before, "before") : null}
      {issue ? (
        <section
          aria-label={["Linear issue", issue.identifier].filter(Boolean).join(" ")}
          className="linear-paste__issue"
        >
          <header className="linear-paste__header">
            {issue.identifier ? (
              <span className="linear-paste__identifier">{issue.identifier}</span>
            ) : null}
            {issue.title ? (
              <span className="linear-paste__title">{issue.title}</span>
            ) : null}
          </header>
          {details.length > 0 ? (
            <ul aria-label="Issue details" className="linear-paste__details">
              {details.map((detail, index) => (
                <li className="linear-paste__detail" key={`${index}:${detail}`}>
                  {detail}
                </li>
              ))}
            </ul>
          ) : null}
          {pieces.length > 0 ? (
            <div className="linear-paste__description">{pieces}</div>
          ) : null}
        </section>
      ) : pieces}
      {after ? props.renderMarkdown(after, "after") : null}
    </div>
  );
}

function renderPiece(
  piece: LinearPastePiece,
  index: number,
  renderMarkdown: (text: string, key: string) => ReactNode,
): ReactNode {
  if (piece.type === "markdown") return renderMarkdown(piece.text, `piece:${index}`);
  return (
    // The transcript's file chip, so attachments and Linear images match.
    <span className="transcript-message__file-chip" key={`piece:${index}`}>
      <span aria-hidden="true" className="transcript-message__file-badge">IMG</span>
      <span className="transcript-message__file-copy">
        <span className="transcript-message__file-name">{piece.name ?? "Linear image"}</span>
      </span>
    </span>
  );
}
