import type { ReactNode } from "react";
import {
  AUTOMATION_DAILY_RUN_LIMIT_OPTIONS,
  AUTOMATION_RUN_TIMEOUT_OPTIONS_MS,
} from "@pwragent/shared";
import { Select } from "../../components/Select";

/** The editor's value for an unset run timeout or daily run limit. */
export const AUTOMATION_LIMIT_OFF = "off";

export function formatRunTimeout(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} hr`;
  return `${minutes} min`;
}

/** Options for a limit, keeping a saved value that is not a preset. */
function withSaved(presets: readonly number[], value: string): string[] {
  const options = presets.map(String);
  if (value !== AUTOMATION_LIMIT_OFF && !options.includes(value)) {
    options.push(value);
    options.sort((left, right) => Number(left) - Number(right));
  }
  return options;
}

/** A Select value for an optional limit: its number, or off. */
export function limitSelectValue(value: number | undefined): string {
  return value === undefined ? AUTOMATION_LIMIT_OFF : String(value);
}

/** The request value: a number, or null to clear a saved one. */
export function parseLimitSelectValue(value: string): number | null {
  if (value === AUTOMATION_LIMIT_OFF) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function dailyCountText(params: {
  runsInLast24Hours?: number;
  dailyRunLimit: string;
}): string | undefined {
  const count = params.runsInLast24Hours;
  if (count === undefined) return undefined;
  const noun = count === 1 ? "run" : "runs";
  return params.dailyRunLimit === AUTOMATION_LIMIT_OFF
    ? `${count} ${noun} in the last 24 hours`
    : `${count} of ${params.dailyRunLimit} runs in the last 24 hours`;
}

/**
 * Run timeout and daily run limit. Both apply to every trigger, and both are
 * off unless the operator sets them.
 */
export function AutomationRunLimitsFields(props: {
  runTimeoutMs: string;
  dailyRunLimit: string;
  /** Saved automations only: runs started in the last 24 hours. */
  runsInLast24Hours?: number;
  pausedAtDailyLimit?: boolean;
  onRunTimeoutChange: (value: string) => void;
  onDailyRunLimitChange: (value: string) => void;
}): ReactNode {
  const timeoutOptions = withSaved(AUTOMATION_RUN_TIMEOUT_OPTIONS_MS, props.runTimeoutMs);
  const dailyOptions = withSaved(AUTOMATION_DAILY_RUN_LIMIT_OPTIONS, props.dailyRunLimit);
  const count = dailyCountText(props);
  return (
    <div className="automation-fieldset">
      <p className="automation-fieldset__legend">Limits</p>
      <div className="automation-inline-fields">
        <label className="automation-field automation-field--compact">
          <span>Run timeout</span>
          <Select
            value={props.runTimeoutMs}
            options={[
              { value: AUTOMATION_LIMIT_OFF, label: "No timeout" },
              ...timeoutOptions.map((option) => ({
                value: option,
                label: formatRunTimeout(Number(option)),
              })),
            ]}
            onChange={props.onRunTimeoutChange}
          />
        </label>
        <label className="automation-field automation-field--compact">
          <span>Daily run limit</span>
          <Select
            value={props.dailyRunLimit}
            options={[
              { value: AUTOMATION_LIMIT_OFF, label: "No limit" },
              ...dailyOptions.map((option) => ({
                value: option,
                label: `${option} runs`,
              })),
            ]}
            onChange={props.onDailyRunLimitChange}
          />
        </label>
      </div>
      {count ? (
        <p className="automation-field__hint" data-testid="automation-daily-run-count">
          {count}
          {props.pausedAtDailyLimit ? " · paused at its daily run limit" : ""}
        </p>
      ) : null}
      <p className="automation-field__hint">
        A run that passes its timeout is stopped and marked failed. Past the
        daily run limit, counted over the last 24 hours, the automation pauses
        and records later triggers as skipped until you resume it.
      </p>
    </div>
  );
}
