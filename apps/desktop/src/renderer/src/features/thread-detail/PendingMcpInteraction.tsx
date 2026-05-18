import {
  canAcceptMcpElicitation,
  redactDisplayValue,
  updateMcpFieldValue,
  type PendingMcpField,
  type PendingMcpInteractionState,
} from "./mcp-elicitation";

type PendingMcpInteractionProps = {
  busy?: boolean;
  state: PendingMcpInteractionState;
  onChange: (state: PendingMcpInteractionState) => void;
  onSubmit: (
    state: PendingMcpInteractionState,
    action: "accept" | "decline" | "cancel"
  ) => Promise<void> | void;
};

export function PendingMcpInteraction(props: PendingMcpInteractionProps) {
  const canAccept = canAcceptMcpElicitation(props.state);
  const toolDescription = readStringMeta(props.state._meta, "tool_description");
  const toolParams = readToolParamsDisplay(props.state._meta);

  return (
    <div className="transcript-mcp" role="group" aria-label="Pending MCP interaction">
      <div className="transcript-mcp__header">
        <span className="chip chip--mode">
          {props.state.mode === "url" ? "MCP login" : "MCP approval"}
        </span>
        <span className="transcript-message__time">
          {props.state.serverName} / {props.state.mode}
        </span>
      </div>

      <div className="transcript-mcp__prompt">
        {toolDescription ? <p className="eyebrow">{toolDescription}</p> : null}
        <h3>{props.state.message}</h3>
      </div>

      {toolParams.length > 0 ? (
        <dl className="transcript-mcp__params">
          {toolParams.map((param) => (
            <div key={param.label}>
              <dt>{param.label}</dt>
              <dd>{redactDisplayValue(param.value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {props.state.url ? (
        <div className="transcript-mcp__url">
          <span>{props.state.url.displayUrl}</span>
          <a
            className="button button--ghost"
            href={props.state.url.url}
            rel="noreferrer"
            target="_blank"
          >
            Open
          </a>
        </div>
      ) : null}

      {props.state.form && props.state.form.fields.length > 0 ? (
        <div className="transcript-mcp__fields">
          {props.state.form.fields.map((field) => (
            <PendingMcpFieldControl
              key={field.key}
              busy={props.busy}
              field={field}
              state={props.state}
              onChange={props.onChange}
            />
          ))}
        </div>
      ) : null}

      <div className="transcript-mcp__actions">
        <button
          className="button button--primary"
          disabled={props.busy || !canAccept}
          type="button"
          onClick={() => {
            void props.onSubmit(props.state, "accept");
          }}
        >
          Allow
        </button>
        <button
          className="button button--ghost"
          disabled={props.busy}
          type="button"
          onClick={() => {
            void props.onSubmit(props.state, "decline");
          }}
        >
          Decline
        </button>
        <button
          className="button button--ghost"
          disabled={props.busy}
          type="button"
          onClick={() => {
            void props.onSubmit(props.state, "cancel");
          }}
        >
          Cancel turn
        </button>
      </div>
    </div>
  );
}

type PendingMcpFieldControlProps = {
  busy?: boolean;
  field: PendingMcpField;
  state: PendingMcpInteractionState;
  onChange: (state: PendingMcpInteractionState) => void;
};

function PendingMcpFieldControl(props: PendingMcpFieldControlProps) {
  const descriptionId = `${props.state.requestId}-${props.field.key}-description`;
  const requiredText = props.field.required ? "Required" : "Optional";

  if (props.field.kind === "unsupported") {
    return (
      <div className="transcript-mcp__field">
        <div className="transcript-mcp__field-label">
          <span>{props.field.label}</span>
          <span>{requiredText}</span>
        </div>
        <p className="transcript-mcp__field-help">
          {props.field.description || "This MCP schema field is not supported yet."}
        </p>
      </div>
    );
  }

  if (props.field.kind === "boolean") {
    return (
      <label className="transcript-mcp__toggle">
        <input
          checked={props.field.value}
          disabled={props.busy}
          type="checkbox"
          onChange={(event) => {
            props.onChange(
              updateMcpFieldValue(props.state, props.field.key, event.target.checked)
            );
          }}
        />
        <span>{props.field.label}</span>
        <span>{requiredText}</span>
      </label>
    );
  }

  if (props.field.kind === "singleSelect") {
    return (
      <label className="transcript-mcp__field">
        <span className="transcript-mcp__field-label">
          <span>{props.field.label}</span>
          <span>{requiredText}</span>
        </span>
        <select
          aria-describedby={props.field.description ? descriptionId : undefined}
          disabled={props.busy}
          value={props.field.value}
          onChange={(event) => {
            props.onChange(
              updateMcpFieldValue(props.state, props.field.key, event.target.value)
            );
          }}
        >
          <option value="">Choose...</option>
          {props.field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {props.field.description ? (
          <span id={descriptionId} className="transcript-mcp__field-help">
            {props.field.description}
          </span>
        ) : null}
      </label>
    );
  }

  if (props.field.kind === "multiSelect") {
    const field = props.field;
    return (
      <fieldset className="transcript-mcp__field">
        <legend className="transcript-mcp__field-label">
          <span>{field.label}</span>
          <span>{requiredText}</span>
        </legend>
        <div className="transcript-mcp__options">
          {field.options.map((option) => {
            const selected = field.value.includes(option.value);
            return (
              <button
                key={option.value}
                className={`transcript-questionnaire__option${
                  selected ? " is-selected" : ""
                }`}
                type="button"
                aria-pressed={selected}
                disabled={props.busy}
                onClick={() => {
                  const nextValue = selected
                    ? field.value.filter((value: string) => value !== option.value)
                    : [...field.value, option.value];
                  props.onChange(
                    updateMcpFieldValue(props.state, field.key, nextValue)
                  );
                }}
              >
                <span className="transcript-questionnaire__option-label">
                  {option.label}
                </span>
              </button>
            );
          })}
        </div>
        {field.description ? (
          <span className="transcript-mcp__field-help">{field.description}</span>
        ) : null}
      </fieldset>
    );
  }

  const field = props.field as Extract<PendingMcpField, { kind: "string" | "number" }>;

  return (
    <label className="transcript-mcp__field">
      <span className="transcript-mcp__field-label">
        <span>{field.label}</span>
        <span>{field.required ? "Required" : "Optional"}</span>
      </span>
      <input
        aria-describedby={field.description ? descriptionId : undefined}
        disabled={props.busy}
        max={field.kind === "number" ? field.maximum : undefined}
        maxLength={field.kind === "string" ? field.maxLength : undefined}
        min={field.kind === "number" ? field.minimum : undefined}
        minLength={field.kind === "string" ? field.minLength : undefined}
        step={field.kind === "number" && field.integer ? 1 : undefined}
        type={field.kind === "number" ? "number" : "text"}
        value={field.value ?? ""}
        onChange={(event) => {
          const nextValue =
            field.kind === "number"
              ? event.target.value
                ? Number(event.target.value)
                : null
              : event.target.value;
          props.onChange(
            updateMcpFieldValue(props.state, field.key, nextValue)
          );
        }}
      />
      {field.description ? (
        <span id={descriptionId} className="transcript-mcp__field-help">
          {field.description}
        </span>
      ) : null}
    </label>
  );
}

function readStringMeta(
  meta: Record<string, unknown> | null,
  key: string
): string | undefined {
  const value = meta?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readToolParamsDisplay(
  meta: Record<string, unknown> | null
): Array<{ label: string; value: unknown }> {
  const raw = meta?.tool_params_display;
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const label =
      typeof record.label === "string" && record.label.trim()
        ? record.label.trim()
        : typeof record.name === "string" && record.name.trim()
          ? record.name.trim()
          : typeof record.key === "string" && record.key.trim()
            ? record.key.trim()
            : undefined;
    if (!label) {
      return [];
    }
    return [{ label, value: record.value }];
  });
}
