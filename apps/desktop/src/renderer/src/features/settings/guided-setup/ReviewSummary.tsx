import type { ReactNode } from "react";
import { CheckIcon } from "./guided-setup-icons";

/** The closing screen of a guided flow: a check, a headline, and what the
 *  flow left in place. */
export function ReviewSummary(props: {
  title: string;
  sub?: ReactNode;
  rows: ReadonlyArray<{ key: string; label: string; value: ReactNode }>;
  children?: ReactNode;
}) {
  return (
    <div className="guided-setup__done">
      <div className="guided-setup__done-check">
        <CheckIcon />
      </div>
      <h1 className="guided-setup__title guided-setup__title--center">
        {props.title}
      </h1>
      {props.sub ? (
        <p className="guided-setup__sub guided-setup__sub--center">{props.sub}</p>
      ) : null}
      <dl className="guided-setup__done-summary">
        {props.rows.map((row) => (
          <div key={row.key}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      {props.children}
    </div>
  );
}
