import { useId, useState } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "../../icons";
import { ThreadMarkdown } from "./ThreadMarkdown";

// A value past either limit goes in the scrolling box instead of the row.
const LONG_TEXT_CHARS = 280;
const LONG_TEXT_LINES = 4;

// react-markdown drops raw HTML, so a comment or tag in the source never
// reaches Preview. The forge hides comments too, which is why the operator
// is told: an instruction can ride in one unseen.
const RAW_HTML = /<!--|<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?\/?>/u;

export function isLongMcpText(value: string): boolean {
  return value.length > LONG_TEXT_CHARS || value.split("\n").length > LONG_TEXT_LINES;
}

// A link's text can say anything; only the source shows where it goes.
const LINK = /\]\(|\]\[|^\s*\[[^\]]+\]:/mu;

// Code is drawn verbatim, so `Array<string>` in backticks hides nothing.
const FENCED_CODE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[ \t]*$|(?![\s\S]))/gmu;
const INLINE_CODE = /(`+)[\s\S]*?\1/gu;

function withoutCode(value: string): string {
  return value.replace(FENCED_CODE, "").replace(INLINE_CODE, "");
}

function markdownHidesHtml(value: string): boolean {
  return RAW_HTML.test(withoutCode(value));
}

/** Markdown whose Preview would hide part of what gets posted. */
export function markdownNeedsSource(value: string): boolean {
  const prose = withoutCode(value);
  return RAW_HTML.test(prose) || LINK.test(prose);
}

type PendingMcpLongTextProps = {
  label: string;
  markdown: boolean;
  value: string;
};

/**
 * The whole of one long argument value, in a box that scrolls inside the
 * card. Markdown opens in Preview with its exact source one tab away; any
 * other text is shown as source only, since nothing says how it renders.
 */
export function PendingMcpLongText(props: PendingMcpLongTextProps) {
  const bodyId = useId();
  const [view, setView] = useState<"preview" | "source">(props.markdown ? "preview" : "source");
  const [expanded, setExpanded] = useState(false);
  const preview = props.markdown && view === "preview";
  const characters = props.value.length.toLocaleString("en-US");

  return (
    <div className={`transcript-mcp__text${expanded ? " is-expanded" : ""}`}>
      <div className="transcript-mcp__text-bar">
        <span className="transcript-mcp__text-meta">
          {props.markdown ? `Markdown · ${characters} characters` : `${characters} characters`}
        </span>
        {props.markdown ? (
          <span className="transcript-mcp__text-views" role="group" aria-label={`${props.label} view`}>
            <button type="button" aria-pressed={view === "preview"} onClick={() => setView("preview")}>
              Preview
            </button>
            <button type="button" aria-pressed={view === "source"} onClick={() => setView("source")}>
              Source
            </button>
          </span>
        ) : null}
        <button
          className="transcript-mcp__text-toggle"
          type="button"
          aria-controls={bodyId}
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${props.label}` : `Expand ${props.label}`}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? <ChevronUpIcon size={11} /> : <ChevronDownIcon size={11} />}
          {expanded ? "Collapse" : "Expand"}
        </button>
      </div>
      {/* The box scrolls, so it takes focus: a keyboard user must be able
          to read all of it before answering. */}
      <div
        id={bodyId}
        className={`transcript-mcp__text-body${preview ? "" : " transcript-mcp__text-body--source"}`}
        role="region"
        aria-label={`${props.label}, full text`}
        tabIndex={0}
      >
        {preview ? <ThreadMarkdown text={props.value} variant="summary" /> : props.value}
      </div>
      {preview && markdownHidesHtml(props.value) ? (
        <p className="transcript-mcp__text-hidden">
          <strong>Preview hides HTML in this text.</strong> Source shows exactly what will be sent.
        </p>
      ) : null}
    </div>
  );
}
