import { useEffect, useId, useRef, useState } from "react";
import type { ForgeApprovalRememberOption, ForgeApprovalRememberOptionId } from "@pwragent/shared";
import { ChevronDownIcon } from "../../icons";
import { openExternalUrl } from "../../lib/open-external-url";
import { useMenuNavigation } from "../../lib/useMenuNavigation";
import {
  canAcceptMcpElicitation,
  mcpElicitationPurposeLabel,
  mcpFieldFormatError,
  mcpFieldFormatPlaceholder,
  mcpSecretFields,
  redactDisplayValue,
  readMcpApprovalPersistence,
  readMcpRememberOptions,
  updateMcpFieldValue,
  type McpApprovalPersistence,
  type PendingMcpField,
  type PendingMcpInteractionState,
} from "./mcp-elicitation";
import { isLongMcpText, markdownNeedsSource, PendingMcpLongText } from "./PendingMcpLongText";
import { ThreadMarkdown } from "./ThreadMarkdown";

type PendingMcpInteractionProps = {
  busy?: boolean;
  state: PendingMcpInteractionState;
  onChange: (state: PendingMcpInteractionState) => void;
  onSubmit: (
    state: PendingMcpInteractionState,
    action: "accept" | "decline" | "cancel",
    persist?: McpApprovalPersistence,
    remember?: ForgeApprovalRememberOptionId,
  ) => Promise<void> | void;
};

export function PendingMcpInteraction(props: PendingMcpInteractionProps) {
  const canAccept = canAcceptMcpElicitation(props.state);
  const toolDescription = readStringMeta(props.state._meta, "tool_description");
  const toolParams = readToolParamsDisplay(props.state._meta);
  const persistModes = readMcpApprovalPersistence(props.state);
  const sessionApproval = persistModes.includes("session");
  const gatewayApproval = props.state._meta?.pwragent_approval_kind === "mcp_tool_call";
  const serverApproval = gatewayApproval && persistModes.includes("server-session");
  const connectorName = readStringMeta(props.state._meta, "connector_name");
  const subtitle = readStringMeta(props.state._meta, "subtitle");
  const highRisk = readStringMeta(props.state._meta, "riskLevel") === "high";
  const purpose = props.state.purpose;
  const secretFields = mcpSecretFields(props.state);
  const url = props.state.url;
  // A forge approval can remember the answer as a project rule. Allow then
  // splits: its menu holds Allow once and each rule the card offers.
  const rememberOptions = url ? [] : readMcpRememberOptions(props.state);
  const primaryLabel = url
    ? "Open in browser"
    : serverApproval
      ? `Allow ${props.state.serverName} for this conversation`
    : sessionApproval
      ? gatewayApproval ? "Allow this tool for this conversation" : "Allow this conversation"
      // Not "Send": E2E specs find the composer's Send button page-wide.
      : purpose === "form" ? "Submit" : "Allow";
  const submitPrimary = (): void => {
    if (url) {
      // Accept means the operator consented to open the page; the
      // server learns whether the flow finished on its own.
      // Open the address exactly as it was shown.
      openExternalUrl(url.fullUrl);
      void props.onSubmit(props.state, "accept");
    } else if (serverApproval) {
      void props.onSubmit(props.state, "accept", "server-session");
    } else if (sessionApproval) {
      void props.onSubmit(props.state, "accept", "session");
    } else {
      void props.onSubmit(props.state, "accept");
    }
  };

  return (
    <div
      className={`transcript-mcp${highRisk ? " transcript-mcp--risk" : ""}`}
      role="group"
      aria-label="Pending MCP interaction"
    >
      <div className="transcript-mcp__header">
        <span className="transcript-mcp__identity">
          <span className="chip chip--mode">{mcpElicitationPurposeLabel(purpose)}</span>
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
            {toolParams.map((param, index) => {
              // A location labels the row; the field it names is the comment.
              const value = redactDisplayValue(param.value, { key: param.key, label: param.location ? undefined : param.label });
              const markdown = param.format === "markdown";
              return (
                // Display names can repeat, so a label is not a stable key.
                // The request id remounts each row for the next approval, so
                // a long value never opens scrolled or in the last one's view.
                <div key={`${props.state.requestId}:${index}`}>
                  <dt className={param.named ? undefined : "transcript-mcp__param-key"}>
                    {param.label}
                  </dt>
                  {/* The operator approves exactly this value, so none of it
                      is cut: a long one scrolls in its own box, and Markdown
                      with links keeps its source one tab away. */}
                  {isLongMcpText(value) || (markdown && markdownNeedsSource(value)) ? (
                    <dd className="transcript-mcp__param-text">
                      <PendingMcpLongText label={param.label} markdown={markdown} value={value} />
                    </dd>
                  ) : markdown ? (
                    <dd className="transcript-mcp__param-markdown">
                      <ThreadMarkdown text={value} variant="summary" />
                    </dd>
                  ) : (
                    <dd>{value}</dd>
                  )}
                </div>
              );
            })}
          </dl>
        ) : null}

        {/* The spec requires the full address before consent, and nothing
            opens until the operator chooses Open in browser. It is text, not
            a link, so no click or prefetch can reach the page first. */}
        {url ? (
          <div className="transcript-mcp__url">
            {url.host ? (
              <p className="transcript-mcp__url-host">
                Opens <strong>{url.host}</strong>
              </p>
            ) : null}
            {/* A long address scrolls, so the box takes focus: a keyboard
                user must be able to read all of it before consenting. */}
            <div className="transcript-mcp__url-full" role="region" aria-label="Full address" tabIndex={0}>
              <code>{url.fullUrl}</code>
            </div>
            {url.internationalHost ? (
              <p className="transcript-mcp__url-warning">
                This address uses international characters. Check that it is the site you expect, because
                such addresses can imitate another site.
              </p>
            ) : null}
            {url.blockedReason ? (
              <p className="transcript-mcp__url-blocked" role="alert">{url.blockedReason}</p>
            ) : null}
          </div>
        ) : null}
      </div>

      {secretFields.length > 0 ? (
        <p className="transcript-mcp__secret-notice" role="alert">
          This form asks for {secretFields.map((field) => field.label).join(", ")}. PwrAgent does not send
          passwords, keys, tokens, or payment details through a form, because the agent can read form answers.
          Decline it; the server must ask for these through a browser page instead.
        </p>
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

      {/* The secondary grant stands apart on the left; the refusals and the
          primary grant sit together on the right, primary last. DOM order is
          the visual order, so Tab walks the row left to right. */}
      <div className="transcript-mcp__actions">
        {gatewayApproval && sessionApproval && rememberOptions.length === 0 ? (
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
        {serverApproval && sessionApproval ? (
          <button
            className="button button--ghost"
            disabled={props.busy || !canAccept}
            type="button"
            onClick={() => {
              void props.onSubmit(props.state, "accept", "session");
            }}
          >
            Allow this tool for this conversation
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
          {rememberOptions.length > 0 ? (
            <PendingMcpAllowSplit
              key={props.state.requestId}
              disabled={Boolean(props.busy) || !canAccept}
              label={primaryLabel}
              options={rememberOptions}
              onAllow={submitPrimary}
              onAllowOnce={() => {
                void props.onSubmit(props.state, "accept");
              }}
              onRemember={(id) => {
                void props.onSubmit(props.state, "accept", undefined, id);
              }}
            />
          ) : (
            <button
              className="button button--primary"
              disabled={props.busy || !canAccept}
              type="button"
              onClick={submitPrimary}
            >
              {primaryLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

type PendingMcpAllowSplitProps = {
  disabled: boolean;
  label: string;
  options: ForgeApprovalRememberOption[];
  onAllow: () => void;
  onAllowOnce: () => void;
  onRemember: (id: ForgeApprovalRememberOptionId) => void;
};

/**
 * Allow with its alternatives one press away. The label runs the card's own
 * grant; the chevron opens Allow once and the project rules the card offers.
 * The chevron's name leaves out "allow", because Playwright matches a name as
 * a substring and a locator for the Allow button must still find one control.
 */
function PendingMcpAllowSplit(props: PendingMcpAllowSplitProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const showMenu = open && !props.disabled;
  const close = (): void => setOpen(false);

  useMenuNavigation({ open: showMenu, menuRef, triggerRef, onClose: close });

  // The keyboard hook leaves the pointer to the menu: any press outside the
  // split closes it.
  useEffect(() => {
    if (!showMenu) return;
    const handlePointerDown = (event: PointerEvent): void => {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [showMenu]);

  const items: Array<{ id: string; label: string; description: string; onSelect: () => void }> = [
    {
      id: "once",
      label: "Allow once",
      description: "Allow this call only. The next one asks again.",
      onSelect: props.onAllowOnce,
    },
    ...props.options.map((option) => ({
      id: option.id,
      label: option.label,
      description: option.description,
      onSelect: () => props.onRemember(option.id),
    })),
  ];

  return (
    <div
      ref={wrapperRef}
      className={`transcript-mcp__split${showMenu ? " transcript-mcp__split--open" : ""}`}
    >
      <button
        className="button button--primary transcript-mcp__split-main"
        disabled={props.disabled}
        type="button"
        onClick={props.onAllow}
      >
        {props.label}
      </button>
      <button
        ref={triggerRef}
        className="button button--primary transcript-mcp__split-toggle"
        aria-label="More approval choices"
        aria-haspopup="menu"
        aria-expanded={showMenu}
        aria-controls={showMenu ? menuId : undefined}
        disabled={props.disabled}
        type="button"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDownIcon size={12} />
      </button>
      {showMenu ? (
        <div
          ref={menuRef}
          id={menuId}
          className="transcript-mcp__split-menu"
          role="menu"
          aria-label="Approval choices"
          tabIndex={-1}
        >
          {items.map((item) => (
            <button
              key={item.id}
              className="transcript-mcp__split-item"
              role="menuitem"
              type="button"
              aria-labelledby={`${menuId}-${item.id}-label`}
              aria-describedby={item.description ? `${menuId}-${item.id}-description` : undefined}
              onClick={() => {
                close();
                item.onSelect();
              }}
            >
              <span id={`${menuId}-${item.id}-label`} className="transcript-mcp__split-item-label">
                {item.label}
              </span>
              {item.description ? (
                <span
                  id={`${menuId}-${item.id}-description`}
                  className="transcript-mcp__split-item-description"
                >
                  {item.description}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
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

  if (props.field.kind === "secret") {
    return (
      <div className="transcript-mcp__field">
        <div className="transcript-mcp__field-label">
          <span>{props.field.label}</span>
          <span>Not collected</span>
        </div>
      </div>
    );
  }

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
  const formatError = mcpFieldFormatError(field);
  const errorId = `${props.state.requestId}-${field.key}-error`;
  const describedBy = [field.description ? descriptionId : undefined, formatError ? errorId : undefined]
    .filter(Boolean).join(" ") || undefined;

  return (
    <label className="transcript-mcp__field">
      <span className="transcript-mcp__field-label">
        <span>{field.label}</span>
        <span>{field.required ? "Required" : "Optional"}</span>
      </span>
      <input
        aria-describedby={describedBy}
        aria-invalid={formatError ? true : undefined}
        autoComplete="off"
        disabled={props.busy}
        inputMode={field.kind === "string" && field.format === "email"
          ? "email"
          : field.kind === "string" && field.format === "uri" ? "url" : undefined}
        max={field.kind === "number" ? field.maximum : undefined}
        maxLength={field.kind === "string" ? field.maxLength : undefined}
        min={field.kind === "number" ? field.minimum : undefined}
        minLength={field.kind === "string" ? field.minLength : undefined}
        placeholder={mcpFieldFormatPlaceholder(field)}
        spellCheck={field.kind === "string" && field.format ? false : undefined}
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
      {formatError ? (
        <span id={errorId} className="transcript-mcp__field-error">{formatError}</span>
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
): Array<{ format?: "markdown"; key: string; label: string; location: boolean; named: boolean; value: unknown }> {
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
    // PwrAgent's inline review comments are labelled `path:line`, verbatim.
    const location = readStringMeta(record, "location");
    const label = location ?? named ?? readStringMeta(record, "name") ?? readStringMeta(record, "key");
    if (!label) {
      return [];
    }
    return [{
      // PwrAgent's own forge rows mark a body the forge renders as Markdown.
      ...(record.format === "markdown" ? { format: "markdown" as const } : {}),
      key: readStringMeta(record, "name") ?? readStringMeta(record, "key") ?? label,
      label,
      location: location !== undefined,
      named: location === undefined && named !== undefined,
      value: record.value,
    }];
  });
}
