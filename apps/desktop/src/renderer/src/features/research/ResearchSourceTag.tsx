import { researchSourceDetail, researchSourceLabel, type ResearchRunView } from "./research-view-model";

/** Where an imported item came from: member and source record, with the full receipt in its tooltip. */
export function ResearchSourceTag({ run, itemId }: { run: Pick<ResearchRunView, "items">; itemId: string }) {
  const detail = researchSourceDetail(run, itemId);
  return <p className="research-source tooltip-target" data-tooltip={detail}>
    From {researchSourceLabel(run, itemId)}<span className="research-sr-only">. {detail}</span>
  </p>;
}
