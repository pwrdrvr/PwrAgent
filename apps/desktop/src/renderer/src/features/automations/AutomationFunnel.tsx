import type { ReactNode } from "react";

/**
 * One stage of the automation funnel.
 *
 * The editor is a pipeline — a message arrives, gets filtered, gets batched,
 * gets analyzed, gets delivered — and the form reads as that pipeline rather
 * than as a flat pile of fields. Each stage carries a lead-in verb ("When",
 * "Only if", "Then run") so the whole form can be read as a sentence.
 *
 * Numbering comes from a CSS counter, not a prop: the filter and throttling
 * stages do not exist for a schedule trigger, and a counter renumbers what
 * remains instead of leaving a gap where stage 2 used to be.
 */
export function AutomationStage(props: {
  children: ReactNode;
  title: string;
  verb: string;
}) {
  return (
    <section className="automation-stage">
      <div className="automation-stage__rail" aria-hidden="true">
        <span className="automation-stage__node" />
      </div>
      <div className="automation-stage__body">
        <div className="automation-stage__head">
          <span className="automation-stage__verb">{props.verb}</span>
          <h3 className="automation-stage__title">{props.title}</h3>
        </div>
        {props.children}
      </div>
    </section>
  );
}

/**
 * The connector between two stages, captioned with what actually survives into
 * the next one ("only messages containing 'ERROR'"). The caption is the part
 * that teaches the model — an unlabeled arrow would just be decoration.
 */
export function AutomationFlow(props: { caption: ReactNode }) {
  return (
    <div className="automation-flow">
      <div className="automation-flow__rail" aria-hidden="true" />
      <p className="automation-flow__caption">{props.caption}</p>
    </div>
  );
}
