import { useCallback } from "react";
import {
  type AutomationInboundCondition,
  type AutomationInboundConditionField,
  type AutomationInboundConditionGroup,
  type AutomationInboundConditionJoin,
  type AutomationInboundConditionOperator,
  type MessagingChannelKind,
  type MessagingSenderSuggestion,
} from "@pwragent/shared";
import { AutomationSenderPicker } from "./AutomationSenderPicker";

/**
 * Operators offered per field. Sender is membership-only on purpose: with
 * `is one of` accepting several people, an operator never needs to nest an OR
 * group to say "PagerDuty or Datadog", which is what keeps this list flat.
 */
const OPERATORS_BY_FIELD: Readonly<
  Record<AutomationInboundConditionField, AutomationInboundConditionOperator[]>
> = {
  message_text: [
    "contains",
    "not_contains",
    "equals",
    "not_equals",
    "starts_with",
    "not_starts_with",
    "matches_regex",
    "not_matches_regex",
  ],
  sender: ["is_one_of", "is_not_one_of"],
  sender_type: ["is_one_of", "is_not_one_of"],
};

const FIELD_LABELS: Readonly<Record<AutomationInboundConditionField, string>> = {
  message_text: "Message text",
  sender: "Sender",
  sender_type: "Sender type",
};

const OPERATOR_LABELS: Readonly<
  Record<AutomationInboundConditionOperator, string>
> = {
  contains: "contains",
  not_contains: "does not contain",
  equals: "equals",
  not_equals: "does not equal",
  starts_with: "starts with",
  not_starts_with: "does not start with",
  matches_regex: "matches regex",
  not_matches_regex: "does not match regex",
  is_one_of: "is one of",
  is_not_one_of: "is not one of",
};

const SENDER_TYPE_VALUES = [
  { value: "human", label: "A person" },
  { value: "bot", label: "A bot or app" },
] as const;

export type AutomationConditionEditorProps = {
  group: AutomationInboundConditionGroup;
  onChange: (group: AutomationInboundConditionGroup) => void;
  provider: MessagingChannelKind | undefined;
  conversationId: string | undefined;
  automationId?: string;
  /**
   * Senders observed in the live preview stream. Passed in rather than fetched
   * here so the picker can offer "seen in this channel" with no extra IPC —
   * the editor is already subscribed to that stream for the preview panel.
   */
  observedSenders: MessagingSenderSuggestion[];
  searchSenders?: (query: string) => Promise<{
    suggestions: MessagingSenderSuggestion[];
    directorySupported: boolean;
    directoryLabel?: string;
    directoryTruncated?: boolean;
  }>;
  /** Display names for already-selected sender ids, so chips are not raw ids. */
  senderLabels: Record<string, string>;
  onSenderLabelsChange: (labels: Record<string, string>) => void;
};

export function AutomationConditionEditor(
  props: AutomationConditionEditorProps,
) {
  const { group, onChange } = props;

  const updateCondition = useCallback(
    (id: string, patch: Partial<AutomationInboundCondition>) => {
      onChange({
        ...group,
        conditions: group.conditions.map((condition) =>
          condition.id === id ? { ...condition, ...patch } : condition,
        ),
      });
    },
    [group, onChange],
  );

  const removeCondition = useCallback(
    (id: string) => {
      onChange({
        ...group,
        conditions: group.conditions.filter((condition) => condition.id !== id),
      });
    },
    [group, onChange],
  );

  const addCondition = useCallback(() => {
    onChange({
      ...group,
      conditions: [
        ...group.conditions,
        {
          id: `condition-${crypto.randomUUID()}`,
          field: "message_text",
          operator: "contains",
          values: [""],
        },
      ],
    });
  }, [group, onChange]);

  const setJoin = useCallback(
    (join: AutomationInboundConditionJoin) => {
      onChange({ ...group, join });
    },
    [group, onChange],
  );


  return (
    <div className="automation-conditions">
      <div className="automation-conditions__head">
        <span className="automation-conditions__lead">Run when</span>
        <div
          className="automation-segmented automation-segmented--compact"
          role="group"
          aria-label="Combine conditions with"
        >
          <button
            type="button"
            className={`automation-segmented__button${group.join === "all" ? " is-active" : ""}`}
            aria-pressed={group.join === "all"}
            onClick={() => setJoin("all")}
          >
            All
          </button>
          <button
            type="button"
            className={`automation-segmented__button${group.join === "any" ? " is-active" : ""}`}
            aria-pressed={group.join === "any"}
            onClick={() => setJoin("any")}
          >
            Any
          </button>
        </div>
        <span className="automation-conditions__lead">of these match</span>
      </div>

      {group.conditions.length === 0 ? (
        <p className="automation-field__hint">
          No conditions — every message in this conversation starts a run.
        </p>
      ) : undefined}

      <ul className="automation-conditions__list">
        {group.conditions.map((condition, index) => (
          <li className="automation-condition" key={condition.id}>
            <span className="automation-condition__joiner" aria-hidden="true">
              {index === 0 ? "" : group.join === "any" ? "or" : "and"}
            </span>
            <label className="automation-condition__control">
              <span className="automation-condition__label">Field</span>
              <select
                value={condition.field}
                onChange={(event) => {
                  const field = event.target.value as AutomationInboundConditionField;
                  // Operators are field-scoped, so switching fields must also
                  // land on an operator that field actually offers — and the
                  // old value is meaningless in the new field.
                  updateCondition(condition.id, {
                    field,
                    operator: OPERATORS_BY_FIELD[field][0],
                    values: field === "message_text" ? [""] : [],
                  });
                }}
              >
                {(
                  Object.keys(FIELD_LABELS) as AutomationInboundConditionField[]
                ).map((field) => (
                  <option key={field} value={field}>
                    {FIELD_LABELS[field]}
                  </option>
                ))}
              </select>
            </label>

            <label className="automation-condition__control">
              <span className="automation-condition__label">Operator</span>
              <select
                value={condition.operator}
                onChange={(event) =>
                  updateCondition(condition.id, {
                    operator: event.target
                      .value as AutomationInboundConditionOperator,
                  })
                }
              >
                {OPERATORS_BY_FIELD[condition.field].map((operator) => (
                  <option key={operator} value={operator}>
                    {OPERATOR_LABELS[operator]}
                  </option>
                ))}
              </select>
            </label>

            <div className="automation-condition__value">
              {condition.field === "message_text" ? (
                <label>
                  <span className="automation-condition__label">Value</span>
                  <input
                    type="text"
                    value={condition.values[0] ?? ""}
                    placeholder={
                      condition.operator === "matches_regex"
                      || condition.operator === "not_matches_regex"
                        ? "p99 .*above SLO"
                        : "ERROR"
                    }
                    onChange={(event) =>
                      updateCondition(condition.id, { values: [event.target.value] })
                    }
                  />
                </label>
              ) : condition.field === "sender_type" ? (
                <label>
                  <span className="automation-condition__label">Sender type</span>
                  <select
                    value={condition.values[0] ?? "human"}
                    onChange={(event) =>
                      updateCondition(condition.id, { values: [event.target.value] })
                    }
                  >
                    {SENDER_TYPE_VALUES.map((entry) => (
                      <option key={entry.value} value={entry.value}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <AutomationSenderPicker
                  selected={condition.values}
                  labels={props.senderLabels}
                  observedSenders={props.observedSenders}
                  provider={props.provider}
                  conversationId={props.conversationId}
                  searchSenders={props.searchSenders}
                  onChange={(values, labels) => {
                    updateCondition(condition.id, { values });
                    // Prune labels no sender condition references any more, so
                    // removing a chip does not leave its display name behind
                    // to accumulate for the life of the editor.
                    const referenced = new Set(
                      group.conditions.flatMap((entry) =>
                        entry.field === "sender"
                          ? entry.id === condition.id
                            ? values
                            : entry.values
                          : [],
                      ),
                    );
                    const merged = { ...props.senderLabels, ...labels };
                    props.onSenderLabelsChange(
                      Object.fromEntries(
                        Object.entries(merged).filter(([id]) => referenced.has(id)),
                      ),
                    );
                  }}
                />
              )}
            </div>

            {condition.field === "message_text" ? (
              <button
                type="button"
                className="automation-condition__icon"
                aria-pressed={condition.caseSensitive === true}
                title="Case sensitive"
                aria-label={`Case sensitive matching for condition ${index + 1}`}
                onClick={() =>
                  updateCondition(condition.id, {
                    caseSensitive: !condition.caseSensitive,
                  })
                }
              >
                Aa
              </button>
            ) : (
              <span className="automation-condition__icon-spacer" aria-hidden="true" />
            )}

            <button
              type="button"
              className="automation-condition__icon"
              aria-label={`Remove condition ${index + 1}`}
              title="Remove condition"
              onClick={() => removeCondition(condition.id)}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>

      <div className="automation-conditions__actions">
        <button type="button" className="button button--ghost" onClick={addCondition}>
          + Condition
        </button>
      </div>
    </div>
  );
}
