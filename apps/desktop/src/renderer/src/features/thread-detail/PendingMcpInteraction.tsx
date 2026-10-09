import {
  canAcceptMcpElicitation,
  redactDisplayValue,
  readMcpApprovalPersistence,
  updateMcpFieldValue,
  type McpApprovalPersistence,
  type PendingMcpField,
  type PendingMcpInteractionState,
} from "./mcp-elicitation";

type PendingMcpInteractionProps = {
  busy?: boolean;
  state: PendingMcpInteractionState;
  onChange: (state: PendingMcpInteractionState) => void;
  onSubmit: (
    state: PendingMcpInteractionState,
    action: "accept" | "decline" | "cancel",
    persist?: McpApprovalPersistence,
  ) => Promise<void> | void;
};

export function PendingMcpInteraction(props: PendingMcpInteractionProps) {
  const canAccept = canAcceptMcpElicitation(props.state);
  const toolDescription = readStringMeta(props.state._meta, "tool_description");
  const toolParams = readToolParamsDisplay(props.state._meta);
  const persistModes = readMcpApprovalPersistence(props.state);
  const sessionApproval = persistModes.includes("session");
  const gatewayApproval = props.state._meta?.pwragent_approval_kind === "mcp_tool_call";
  const connectorName = readStringMeta(props.state._meta, "connector_name");
  const subtitle = readStringMeta(props.state._meta, "subtitle");
  const highRisk = readStringMeta(props.state._meta, "riskLevel") === "high";

  return (
    <div
      className={`transcript-mcp${highRisk ? " transcript-mcp--risk" : ""}`}
      role="group"
      aria-label="Pending MCP interaction"
    >
      <div className="transcript-mcp__header">
        <span className="transcript-mcp__identity">
          <span className="chip chip--mode">
            {props.state.mode === "url" ? "MCP login" : "MCP approval"}
          </span>
          {connectorName ? (
            <span className="transcript-mcp__connector">{connectorName}</span>
          ) : null}
        </span>
        <span className="transcript-mcp__server">{props.state.serverName}</span>
      </div>

      <div className="transcript-mcp__summary">
        <div className="transcript-mcp__prompt">
          {toolDescription ? <p className="eyebrow">{toolDescription}</p> : null}
          <h3>{props.state.message}</h3>
          {subtitle ? <p className="transcript-mcp__subtitle">{subtitle}</p> : null}
        </div>

        {toolParams.length > 0 ? (
          <dl className="transcript-mcp__params">
            {toolParams.map((param, index) => (
              // Display names can repeat, so a label is not a stable key.
              <div key={index}>
                <dt className={param.named ? undefined : "transcript-mcp__param-key"}>
                  {param.label}
                </dt>
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
      </div>

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

      {/* The secondary grant stands apart on the left; the refusals and the
          primary grant sit together on the right, primary last. DOM order is
          the visual order, so Tab walks the row left to right. */}
      <div className="transcript-mcp__actions">
        {gatewayApproval && sessionApproval ? (
          <button
            className="button button--ghost"
            disabled={props.busy || !canAccept}
            type="button"
            onClick={() => {
              void props.onSubmit(props.state, "accept");
            }}
          >
            Allow once
          </button>
        ) : null}
        {persistModes.includes("always") ? (
          <button
            className="button button--ghost"
            disabled={props.busy || !canAccept}
            type="button"
            onClick={() => {
              void props.onSubmit(props.state, "accept", "always");
            }}
          >
            Always allow
          </button>
        ) : null}
        <div className="transcript-mcp__actions-end">
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
            className="button button--primary"
            disabled={props.busy || !canAccept}
            type="button"
            onClick={() => {
              if (sessionApproval) {
                void props.onSubmit(props.state, "accept", "session");
              } else {
                void props.onSubmit(props.state, "accept");
              }
            }}
          >
            {sessionApproval ? "Allow this conversation" : "Allow"}
          </button>
        </div>
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
): Array<{ label: string; named: boolean; value: unknown }> {
  const raw = meta?.tool_params_display;
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    // `label` and `display_name` are written for people (Computer Use sends
    // `{ name: "app", display_name: "App" }`); `name` and `key` are the raw
    // parameter key, drawn verbatim in mono.
    const named = readStringMeta(record, "label") ?? readStringMeta(record, "display_name");
    const label = named ?? readStringMeta(record, "name") ?? readStringMeta(record, "key");
    if (!label) {
      return [];
    }
    return [{ label, named: named !== undefined, value: record.value }];
  });
}
