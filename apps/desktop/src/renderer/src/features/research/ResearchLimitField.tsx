import { useId } from "react";
import { RESEARCH_MAX_MINUTES } from "@pwragent/shared";
import { Select } from "../../components/Select";

const UNITS = [{ value: "minutes", label: "Minutes", minutes: 1 }, { value: "hours", label: "Hours", minutes: 60 }, { value: "days", label: "Days", minutes: 1440 }] as const;
export type ResearchLimitUnit = typeof UNITS[number]["value"];

/** One optional limit as the operator is editing it. `limited` false is No limit, whatever length is shown. */
export type ResearchLimitDraft = { limited: boolean; length: number; unit: ResearchLimitUnit };

/** A draft for a limit: No limit when there is none, else the limit in the largest unit it fills exactly. */
export function researchLimitDraft(minutes: number | undefined, fallback: Omit<ResearchLimitDraft, "limited">): ResearchLimitDraft {
  if (minutes === undefined) return { limited: false, ...fallback };
  const unit = [...UNITS].reverse().find((entry) => minutes % entry.minutes === 0)!;
  return { limited: true, length: minutes / unit.minutes, unit: unit.value };
}

/** The draft's limit in minutes, undefined for No limit, or NaN for a length that is not a whole number in range. */
export function researchLimitMinutes(draft: ResearchLimitDraft): number | undefined {
  if (!draft.limited) return undefined;
  const minutes = draft.length * UNITS.find((entry) => entry.value === draft.unit)!.minutes;
  return Number.isInteger(draft.length) && draft.length >= 1 && minutes <= RESEARCH_MAX_MINUTES ? minutes : Number.NaN;
}

/** No limit, or a length and unit: the control every optional research limit uses, on the start form and the run card. */
export function ResearchLimitField({ label, draft, onChange }: { label: string; draft: ResearchLimitDraft; onChange: (draft: ResearchLimitDraft) => void }) {
  const id = useId();
  return <div className="research-field" role="group" aria-labelledby={`${id}-label`}>
    <span id={`${id}-label`}>{label}</span>
    <div className="research-switch">
      <button type="button" aria-pressed={!draft.limited} onClick={() => onChange({ ...draft, limited: false })}>No limit</button>
      <button type="button" aria-pressed={draft.limited} onClick={() => onChange({ ...draft, limited: true })}>Set a limit</button>
    </div>
    {draft.limited && <div className="research-form__row">
      <label>Length<input type="number" min={1} required value={draft.length} onChange={(event) => onChange({ ...draft, length: Number(event.target.value) })} /></label>
      <label>Unit<Select value={draft.unit} onChange={(value) => onChange({ ...draft, unit: value as ResearchLimitUnit })} className="research-select" options={UNITS.map((entry) => ({ value: entry.value, label: entry.label }))} /></label>
    </div>}
  </div>;
}
