import { useId, useRef, useState } from "react";
import {
  HOT_CPU_RULE_DURATIONS,
  HOT_CPU_RULE_LABELS,
  isHotCpuThreshold,
  migrateHotCpuCaptureRules,
  setHotCpuRuleEnabled,
  type EffectiveHotCpuRule,
  type HighCpuMode,
  type HotCpuCaptureRules,
  type HotCpuRuleId,
  type HotCpuRulePlan,
} from "@pwragent/shared/hot-cpu-rules";
import type { DesktopSettingsSnapshot } from "@pwragent/shared/contracts/settings";
import { Select } from "../../components/Select";
import { SegmentedControl, SettingsField } from "./SettingsLayout";
import { sourceBadge } from "./settings-fields";

const LAST_RULE = "At least one rule stays on. To stop capturing, use Stop Capture.";
const CPU_HELP = "Percent of one CPU core, averaged over each sample. Multi-threaded work can go above 100%.";
const HIGH_MODES: Array<{ value: HighCpuMode; label: string; tooltip: string }> = [
  { value: "spike", label: "Spike", tooltip: "Starts a capture on one sample at or above the threshold." },
  { value: "sustained", label: "Sustained", tooltip: "Needs every sample in the duration to stay at or above the threshold." },
];

const seconds = (ms: number) => `${ms / 1_000} s`;
const samples = (count: number) => `${count} ${count === 1 ? "sample" : "samples"}`;

function describeRule(rule: EffectiveHotCpuRule, cadenceMs: number): string {
  const atLeast = `at least ${rule.thresholdPercent}% of one core`;
  if (rule.sampleCount === 1) return `${atLeast} in one ${seconds(cadenceMs)} sample`;
  const window = rule.sampleCount * cadenceMs === rule.durationMs
    ? seconds(rule.durationMs)
    : `${seconds(rule.durationMs)} minimum`;
  return `${atLeast} across ${rule.sampleCount} consecutive ${seconds(cadenceMs)} samples (${window})`;
}

function RuleThreshold(props: {
  label: string;
  value: number;
  disabled: boolean;
  onChange: (value: number) => Promise<boolean>;
}) {
  const id = useId();
  const writing = useRef(false);
  const [draft, setDraft] = useState<string>();
  const invalid = draft !== undefined && !isHotCpuThreshold(Number(draft));
  const value = props.disabled ? String(props.value) : draft ?? String(props.value);
  const commit = async () => {
    if (props.disabled || invalid || draft === undefined || writing.current) return;
    const next = Number(draft);
    if (next === props.value) {
      setDraft(undefined);
      return;
    }
    writing.current = true;
    try {
      if (await props.onChange(next)) setDraft(undefined);
    } finally {
      writing.current = false;
    }
  };
  return (
    <>
      <label className="settings-cpu-rules__threshold tooltip-target" data-tooltip={CPU_HELP}>
        <span>at least</span>
        <input
          aria-label={`${props.label} CPU threshold`}
          aria-invalid={invalid && !props.disabled ? true : undefined}
          aria-errormessage={invalid && !props.disabled ? id : undefined}
          className="settings-input"
          type="number"
          min={1}
          max={400}
          step={1}
          value={value}
          disabled={props.disabled}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={() => { void commit(); }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && draft !== undefined) {
              event.preventDefault();
              setDraft(undefined);
            } else if (event.key === "Enter") {
              event.preventDefault();
              void commit();
            } else if (event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
              event.preventDefault();
              const delta = event.key === "ArrowUp" ? 10 : -10;
              setDraft(String(Math.min(400, Math.max(1, (Number(value) || 1) + delta))));
            }
          }}
        />
        <span>% CPU</span>
      </label>
      {invalid && !props.disabled ? (
        <p className="settings-row__error settings-cpu-rules__error" id={id} role="alert">
          Enter a whole number from 1 to 400.
        </p>
      ) : null}
    </>
  );
}

function RuleValues(props: {
  id: HotCpuRuleId;
  rule: HotCpuCaptureRules[HotCpuRuleId];
  disabled: boolean;
  effective: HotCpuRulePlan;
  onThresholdChange: (value: number) => Promise<boolean>;
  onDurationChange: (value: string) => void;
}) {
  const { effective, id, rule } = props;
  const active = effective.rules.find((candidate) => candidate.id === id);
  const overrides = effective.overrides;
  const thresholdOverride = id === "slowburn" ? overrides.slowburnThreshold : overrides.highThreshold;
  const timingLocked = Boolean(overrides.mode || (id === "spike" ? overrides.interval : overrides.sampleCount));
  const lockedDuration = timingLocked && active;
  const label = HOT_CPU_RULE_LABELS[id];
  const options = lockedDuration ? [{
    value: String(lockedDuration.durationMs),
    label: `${seconds(lockedDuration.durationMs)} · ${samples(lockedDuration.sampleCount)}`,
  }] : HOT_CPU_RULE_DURATIONS[id].map((ms) => {
    const count = id === "spike" ? 1 : Math.max(2, Math.ceil(ms / effective.intervalMs));
    return { value: String(ms), label: `${seconds(ms)} · ${samples(count)}` };
  });
  return (
    <div className="settings-cpu-rules__values">
      <RuleThreshold
        label={label}
        value={active?.thresholdPercent ?? rule.thresholdPercent}
        disabled={props.disabled || Boolean(thresholdOverride)}
        onChange={props.onThresholdChange}
      />
      <div className="settings-cpu-rules__duration tooltip-target"
        data-tooltip={`CPU is averaged every ${seconds(effective.intervalMs)}. Each sample in the window must meet the threshold.`}>
        <span>for</span>
        <Select
          aria-label={`${label} duration`}
          className="settings-input"
          options={options}
          value={String(lockedDuration ? lockedDuration.durationMs : rule.durationMs)}
          disabled={props.disabled || timingLocked}
          onChange={props.onDurationChange}
        />
      </div>
    </div>
  );
}

export function HotCpuCaptureRulesField(props: {
  setting: DesktopSettingsSnapshot["general"]["hotCpuProfilingCaptureRules"];
  saving: boolean;
  onChange: (rules: HotCpuCaptureRules) => Promise<boolean>;
}) {
  const id = useId();
  const writing = useRef(false);
  const [status, setStatus] = useState("");
  const { setting } = props;
  const { effective, value: configured } = setting;
  const { overrides, intervalMs } = effective;
  const modeLocked = Boolean(overrides.mode);
  const displayed = overrides.mode ? migrateHotCpuCaptureRules(effective.rules[0].id) : configured;
  const highId = displayed.highMode;
  const [first, second] = effective.rules;
  const redundant = second && second.thresholdPercent >= first.thresholdPercent
    && second.durationMs >= first.durationMs && second.sampleCount >= first.sampleCount;
  const summary = effective.rules.map((rule) => describeRule(rule, intervalMs)).join(", or ");
  const save = async (rules: HotCpuCaptureRules) => {
    if (modeLocked || props.saving || writing.current) return false;
    writing.current = true;
    try {
      setStatus("");
      return await props.onChange(rules);
    } finally {
      writing.current = false;
    }
  };
  const groupToggle = (group: "high" | "slowburn") => {
    const high = group === "high";
    const checked = high ? displayed.highEnabled : displayed.slowburn.enabled;
    const last = !modeLocked && checked && !(high ? displayed.slowburn.enabled : displayed.highEnabled);
    const tooltip = last ? LAST_RULE : high ? undefined : "A lower threshold for steady work that never spikes.";
    return (
      <label className="settings-cpu-rules__toggle">
        <input
          className="tooltip-target"
          data-tooltip={tooltip}
          type="checkbox"
          checked={checked}
          disabled={modeLocked}
          aria-disabled={last || undefined}
          onClick={(event) => {
            if (!last) return;
            event.preventDefault();
            setStatus(LAST_RULE);
          }}
          onChange={(event) => {
            if (!last) void save(setHotCpuRuleEnabled(configured, group, event.currentTarget.checked));
          }}
        />
        {high ? "High CPU" : "Slow burn"}
      </label>
    );
  };
  const slowburn = displayed.slowburn;
  return (
    <SettingsField
      label="Capture rules"
      labelId={`${id}-label`}
      sub="Start a capture when any checked rule matches."
      source={setting.source === "env" ? "env override" : sourceBadge(setting)}
      control={
        <div className="settings-cpu-rules" role="group" aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-summary`} aria-busy={props.saving || undefined}>
          <div className="settings-cpu-rules__rule">
            <div className="settings-cpu-rules__head">
              {groupToggle("high")}
              <SegmentedControl
                label="High CPU mode"
                options={HIGH_MODES}
                value={highId}
                disabled={modeLocked || !displayed.highEnabled}
                rovingFocus
                onChange={(highMode) => { void save({ ...configured, highMode }); }}
              />
            </div>
            <RuleValues
              key={highId}
              id={highId}
              rule={displayed[highId]}
              disabled={modeLocked || !displayed.highEnabled}
              effective={effective}
              onThresholdChange={(thresholdPercent) => save({
                ...configured,
                [highId]: { ...configured[highId], thresholdPercent },
              })}
              onDurationChange={(value) => {
                if (highId === "spike") {
                  const durationMs = HOT_CPU_RULE_DURATIONS.spike.find((ms) => String(ms) === value);
                  if (durationMs) void save({ ...configured, spike: { ...configured.spike, durationMs } });
                } else {
                  const durationMs = HOT_CPU_RULE_DURATIONS.sustained.find((ms) => String(ms) === value);
                  if (durationMs) void save({ ...configured, sustained: { ...configured.sustained, durationMs } });
                }
              }}
            />
          </div>
          <div className="settings-cpu-rules__rule">
            <div className="settings-cpu-rules__head">
              {groupToggle("slowburn")}
              <span className="settings-field__help">Lower threshold, longer window</span>
            </div>
            <RuleValues
              id="slowburn"
              rule={slowburn}
              disabled={modeLocked || !slowburn.enabled}
              effective={effective}
              onThresholdChange={(thresholdPercent) => save({
                ...configured, slowburn: { ...configured.slowburn, thresholdPercent },
              })}
              onDurationChange={(value) => {
                const durationMs = HOT_CPU_RULE_DURATIONS.slowburn.find((ms) => String(ms) === value);
                if (durationMs) void save({ ...configured, slowburn: { ...configured.slowburn, durationMs } });
              }}
            />
          </div>
          <p id={`${id}-summary`} aria-live="polite">
            Starts a capture when the main process or any window uses {summary}.
          </p>
          <p className="settings-field__help">
            Rules match at the end of a sample after enough consecutive samples meet the threshold.
            Rules that match together are named in one capture.
          </p>
          {overrides.mode ? (
            <p className="settings-field__help">
              Set by <code>{overrides.mode}</code> in this app’s environment. Unset it to edit these rules here.
            </p>
          ) : null}
          {[overrides.highThreshold, overrides.slowburnThreshold, overrides.interval, overrides.sampleCount].some(Boolean) ? (
            <p className="settings-field__help">
              Environment overrides apply to these rules. <code>{
                [overrides.highThreshold, overrides.slowburnThreshold, overrides.interval, overrides.sampleCount]
                  .filter(Boolean).join(", ")
              }</code>
            </p>
          ) : null}
          {redundant ? <p className="settings-field__value--warn">
            Slow burn adds no matches at this threshold and duration. Lower its threshold or shorten its duration.
          </p> : null}
          <div className="settings-field__help" role="status">{status}</div>
        </div>
      }
    />
  );
}
