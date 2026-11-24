import { useState, type ReactElement } from "react";
import "./continuation-text.css";

/** Past this length a continuation shows three lines until it is opened. */
export const CONTINUATION_CLAMP_CHARACTERS = 160;

/** Whether a continuation is long enough to start clamped. */
export function continuationIsLong(text: string): boolean {
  return text.length > CONTINUATION_CLAMP_CHARACTERS || text.split("\n").length > 3;
}

/**
 * What a waiting thread is told when it wakes. These are often whole
 * command lines with paths, so a long one starts at three lines.
 */
export function ContinuationText(props: { label: string; text: string }): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const long = continuationIsLong(props.text);
  return (
    <span className="continuation-text" data-testid="continuation-text">
      <span className="continuation-text__label">{props.label}</span>
      <span className={`continuation-text__body${long && !expanded ? " is-clamped" : ""}`}>{props.text}</span>
      {long ? (
        <button
          type="button"
          className="continuation-text__toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show less" : "Show all"}
        </button>
      ) : null}
    </span>
  );
}
