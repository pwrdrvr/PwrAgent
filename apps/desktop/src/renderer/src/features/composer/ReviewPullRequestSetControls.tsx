import { useId } from "react";
import {
  CLAUDE_CODE_REVIEW_LEVELS,
  type ClaudeCodeReviewLevel,
} from "../../../../shared/review-command";

/**
 * Once two or more pull requests are checked: one review each, queued in
 * list order, or one review that reads them all together.
 */
export function ReviewPullRequestModeChoice(props: {
  count: number;
  together: boolean;
  /** What Together does here, under its label. */
  togetherDescription: string;
  /** Why Together is unavailable, in place of its description. */
  togetherUnavailableReason?: string;
  onChange: (together: boolean) => void;
}) {
  const name = useId();
  const legendId = useId();
  const options = [
    {
      together: false,
      label: `Separately · ${props.count} reviews`,
      description: "One review per pull request, one after another",
      disabled: false,
    },
    {
      together: true,
      label: "Together · 1 review",
      description: props.togetherUnavailableReason ?? props.togetherDescription,
      disabled: Boolean(props.togetherUnavailableReason),
    },
  ];
  return (
    <div className="composer__review-mode-choice" role="radiogroup" aria-labelledby={legendId}>
      <span id={legendId} className="composer__review-mode-legend">Review them</span>
      <div className="composer__review-mode-options">
        {options.map((option) => {
          const checked = props.together === option.together && !option.disabled;
          return (
            <label
              key={String(option.together)}
              className={`composer__review-mode-option${checked ? " is-active" : ""}${option.disabled ? " is-disabled" : ""}`}
            >
              <input
                className="review-pr-picker__input"
                type="radio"
                name={name}
                checked={checked}
                disabled={option.disabled}
                onChange={() => props.onChange(option.together)}
              />
              <span className="composer__review-mode-text">
                <span>{option.label}</span>
                <small>{option.description}</small>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/** Claude Code's `/code-review` effort, low to max. `ultra` is not offered. */
export function ClaudeCodeReviewEffort(props: {
  value: ClaudeCodeReviewLevel;
  onChange: (level: ClaudeCodeReviewLevel) => void;
}) {
  const labelId = useId();
  return (
    <span className="composer__review-effort">
      <span id={labelId} className="composer__review-effort-label">Effort</span>
      <span className="composer__review-effort-levels" role="group" aria-labelledby={labelId}>
        {CLAUDE_CODE_REVIEW_LEVELS.map((level) => (
          <button
            key={level}
            type="button"
            aria-pressed={props.value === level}
            onClick={() => props.onChange(level)}
          >
            {level}
          </button>
        ))}
      </span>
    </span>
  );
}

/** The exact `/code-review` text a Claude Code review sends, or why it cannot. */
export function ClaudeCodeReviewCommandPreview(props: {
  commands: readonly string[];
  problem?: string;
}) {
  if (props.problem) {
    return <p className="composer__review-note">{props.problem}</p>;
  }
  if (props.commands.length === 0) return null;
  return (
    <p className="composer__review-command">
      {"Sends "}
      {props.commands.map((command, index) => (
        <span key={command}>
          {index > 0 ? ", then " : null}
          <code>{command}</code>
        </span>
      ))}
    </p>
  );
}
