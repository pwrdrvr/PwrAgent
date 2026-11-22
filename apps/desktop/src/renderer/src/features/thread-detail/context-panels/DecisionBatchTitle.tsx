import type { DecisionsRailBatch } from "@pwragent/shared/decisions-rail";
import { decisionBatchTitle, decisionBatchVersionTag, decisionProviderLabel } from "./decisions-format";

/** A batch's name, its version (none for ad hoc), and its provider. */
export function BatchTitle(props: {
  batch: Pick<DecisionsRailBatch, "adHoc" | "name" | "version" | "provider">;
  className: string;
  model?: string;
}) {
  const version = decisionBatchVersionTag(props.batch);
  return (
    <p className={props.className}>
      <span className={props.batch.adHoc ? "decisions-batch__name decisions-batch__name--ad-hoc" : "decisions-batch__name"}>
        {decisionBatchTitle(props.batch)}
      </span>
      {props.batch.adHoc ? <span className="decisions-panel__tag decisions-panel__tag--ad-hoc">not stored</span> : null}
      {version ? <span className="decisions-panel__tag">{version}</span> : null}
      <span className="rail-card__provider-chip">
        {[decisionProviderLabel(props.batch.provider), props.model].filter(Boolean).join(" · ")}
      </span>
    </p>
  );
}
