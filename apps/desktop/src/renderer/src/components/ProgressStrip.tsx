import type { ReactNode } from "react";
import { DOWNLOAD_METER_RESERVE } from "../lib/download-meter";

// The one progress layout every download card renders: the managed runtimes'
// strip (Codex, Grok, Git, Antigravity, in Settings and notices) and
// PwrAgent's own update card. Four rows, none of which comes or goes, and
// none of which changes height, between the first busy phase and the end:
//
//   state line   eyebrow, and the version once it is known
//   status line  the phase message, or the byte meter while bytes arrive
//   track        sweep, percent, or full
//   steps        the stages the work passes through
//
// The status line stacks every line the card can show, invisibly, in one
// grid cell, so it is the longest line's height from the first frame. A
// phase change swaps text in place. In a bottom-anchored stack every pixel a
// card gains moves its top, and everything above it, up.

export type ProgressStripTone = "busy" | "ok" | "error" | "notice";

export type ProgressStripStepState = "done" | "now" | "failed" | "todo";

export type ProgressStripStep = {
  key: string;
  label: string;
  state: ProgressStripStepState;
};

const STEP_MARK = { done: "✓", now: "●", failed: "✕", todo: "○" } as const;
const STEP_STATE_LABEL = {
  done: "done",
  now: "in progress",
  failed: "failed",
  todo: "waiting",
} as const;

export function ProgressStrip(props: {
  tone: ProgressStripTone;
  eyebrow: string;
  /** Version or release tag, beside the eyebrow once one is known. */
  tag?: string;
  /** The phase message, or the byte meter when `lineIsMeter`. */
  line: string | undefined;
  lineIsMeter?: boolean;
  /** Every other message this card can show, held invisibly so the status
   *  line never grows. The byte meter's line is always held. */
  reservedLines: readonly string[];
  /** Omitted for a settled card with nothing to draw. `percent` undefined is
   *  the indeterminate sweep; `full` is a finished bar. */
  track?: { percent?: number; full?: boolean; label: string };
  steps?: readonly ProgressStripStep[];
  /** Inside a card that already draws its own frame, such as the update card. */
  flat?: boolean;
  testId?: string;
  children?: ReactNode;
}) {
  const { track } = props;
  const indeterminate = track !== undefined && track.percent === undefined && track.full !== true;
  const percent = track?.full === true ? 100 : track?.percent;
  return (
    <div
      className={`progress-strip progress-strip--${props.tone}${props.flat ? " progress-strip--flat" : ""}`}
      data-testid={props.testId}
    >
      <div className="progress-strip__head">
        <p className="progress-strip__eyebrow">{props.eyebrow}</p>
        {props.tag ? <span className="progress-strip__tag">{props.tag}</span> : null}
      </div>
      {/* `aria-live="off"`: inside a live region (the update card is one),
          the meter and the percent would otherwise be announced at every
          report and bury the phase changes the eyebrow announces. */}
      <div className="progress-strip__status" aria-live="off">
        <p className={props.lineIsMeter ? "progress-strip__meter" : "progress-strip__message"}>
          {props.line ?? " "}
        </p>
        {props.reservedLines
          .filter((text) => text !== props.line)
          .map((text) => (
            <p aria-hidden="true" className="progress-strip__message progress-strip__reserve" key={text}>
              {text}
            </p>
          ))}
        <p aria-hidden="true" className="progress-strip__meter progress-strip__reserve">
          {DOWNLOAD_METER_RESERVE}
        </p>
      </div>
      {track ? (
        // An indeterminate progressbar is a progressbar without a value: the
        // role stays, so a screen reader still hears that work is running.
        <span
          aria-label={track.label}
          aria-live="off"
          aria-valuemax={percent === undefined ? undefined : 100}
          aria-valuemin={percent === undefined ? undefined : 0}
          aria-valuenow={percent}
          className={`progress-strip__track${
            indeterminate ? " progress-strip__track--indeterminate" : ""
          }${track.full ? " progress-strip__track--full" : ""}`}
          role="progressbar"
        >
          <i style={percent === undefined ? undefined : { width: `${percent}%` }} />
        </span>
      ) : null}
      {props.steps ? (
        <ol className="progress-strip__steps">
          {props.steps.map((step) => (
            <li
              aria-current={step.state === "now" ? "step" : undefined}
              aria-label={`${step.label}, ${STEP_STATE_LABEL[step.state]}`}
              className={`is-${step.state}`}
              key={step.key}
            >
              <span aria-hidden="true">
                {STEP_MARK[step.state]} {step.label}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {props.children}
    </div>
  );
}
