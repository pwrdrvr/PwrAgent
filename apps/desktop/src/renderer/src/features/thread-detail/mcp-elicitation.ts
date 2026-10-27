import {
  isSecretFieldLabel,
  isSecretFieldName,
  mcpElicitationPurpose,
  type AppServerMcpElicitationRequestNotification,
  type AppServerMcpElicitationResponse,
  type McpElicitationPurpose,
} from "@pwragent/shared";

export type PendingMcpFieldOption = {
  value: string;
  label: string;
};

/** The string formats the MCP elicitation schema allows. */
export type McpStringFormat = "email" | "uri" | "date" | "date-time";

export type PendingMcpField =
  | {
      kind: "string";
      key: string;
      label: string;
      description: string;
      required: boolean;
      minLength?: number;
      maxLength?: number;
      format?: McpStringFormat;
      value: string;
    }
  | {
      kind: "number";
      key: string;
      label: string;
      description: string;
      required: boolean;
      integer: boolean;
      minimum?: number;
      maximum?: number;
      value: number | null;
    }
  | {
      kind: "boolean";
      key: string;
      label: string;
      description: string;
      required: boolean;
      value: boolean;
    }
  | {
      kind: "singleSelect";
      key: string;
      label: string;
      description: string;
      required: boolean;
      options: PendingMcpFieldOption[];
      value: string;
    }
  | {
      kind: "multiSelect";
      key: string;
      label: string;
      description: string;
      required: boolean;
      options: PendingMcpFieldOption[];
      minItems?: number;
      maxItems?: number;
      value: string[];
    }
  | {
      kind: "unsupported";
      key: string;
      label: string;
      description: string;
      required: boolean;
    }
  | {
      // A password, key, token or payment credential. The MCP spec forbids
      // collecting these in form mode, because form values reach the client
      // and can land in the transcript. The server must use URL mode.
      kind: "secret";
      key: string;
      label: string;
      description: string;
      required: boolean;
    };

export type PendingMcpUrl = {
  url: string;
  /**
   * The address as the browser will read it. A lookalike host shows as
   * punycode here, where the raw string would show the imitated name.
   */
  fullUrl: string;
  /** Only the 2025-11-25 revision sends one; 2026-07-28 removed it. */
  elicitationId?: string;
  /** The ASCII hostname the browser will contact. */
  host: string;
  /** A label is punycode: the host may imitate another site. */
  internationalHost: boolean;
  /** Why PwrAgent will not open this URL, if it will not. */
  blockedReason?: string;
};

export type PendingMcpInteractionState = {
  method: "mcpServer/elicitation/request";
  requestId: string;
  threadId: string;
  turnId?: string | null;
  serverName: string;
  message: string;
  mode: "form" | "url";
  /** See `mcpElicitationPurpose` in `@pwragent/shared`. */
  purpose: McpElicitationPurpose;
  _meta: Record<string, unknown> | null;
  form: {
    empty: boolean;
    fields: PendingMcpField[];
  } | null;
  url: PendingMcpUrl | null;
};

type FieldValue = string | number | boolean | string[] | null;

export type McpApprovalPersistence = "session" | "always" | "server-session";

// The request's owner (Codex, the gateway or the upstream server) holds the
// grant. Only offer advertised scopes; forms and login flows need input.
export function readMcpApprovalPersistence(state: PendingMcpInteractionState): McpApprovalPersistence[] {
  if (!isMcpToolApproval(state)) {
    return [];
  }
  const meta = state._meta;
  const modes = Array.isArray(meta?.persist) ? meta.persist : [meta?.persist];
  if (modes.length === 0 || modes.some((mode) => mode !== "session" && mode !== "always"
    && !(mode === "server-session" && meta?.pwragent_approval_kind === "mcp_tool_call"))) {
    return [];
  }
  return [...new Set(modes)] as McpApprovalPersistence[];
}

/** Permission to run a tool, not a request for data. */
export function isMcpToolApproval(state: PendingMcpInteractionState): boolean {
  return state.purpose === "tool-approval";
}

export function mcpElicitationPurposeLabel(purpose: McpElicitationPurpose): string {
  switch (purpose) {
    case "tool-approval": return "Tool approval";
    case "confirmation": return "MCP confirmation";
    case "form": return "MCP input";
    case "url": return "MCP link";
  }
}

/** The form fields that make this request impossible to submit. */
export function mcpSecretFields(state: PendingMcpInteractionState): PendingMcpField[] {
  return state.form?.fields.filter((field) => field.kind === "secret") ?? [];
}

export function createMcpElicitationState(
  request: AppServerMcpElicitationRequestNotification
): PendingMcpInteractionState | undefined {
  const requestId = trimString(request.params.requestId);
  const threadId = trimString(request.params.threadId);
  const serverName = trimString(request.params.serverName);
  const message = trimString(request.params.message);
  if (!requestId || !threadId || !serverName || !message) {
    return undefined;
  }

  if (request.params.mode === "url") {
    const url = trimString(request.params.url);
    if (!url) {
      return undefined;
    }

    return baseState(request, {
      form: null,
      url: readElicitationUrl(url, trimString(request.params.elicitationId)),
    });
  }

  const schema = request.params.requestedSchema;
  if (!schema || schema.type !== "object") {
    return undefined;
  }

  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const properties = asRecord(schema.properties) ?? {};
  const fields = Object.entries(properties).map(([key, value]) =>
    buildField(key, asRecord(value) ?? {}, required.has(key))
  );

  return baseState(request, {
    form: {
      empty: fields.length === 0,
      fields,
    },
    url: null,
  });
}

export function updateMcpFieldValue(
  state: PendingMcpInteractionState,
  key: string,
  value: FieldValue
): PendingMcpInteractionState {
  if (!state.form) {
    return state;
  }

  return {
    ...state,
    form: {
      ...state.form,
      fields: state.form.fields.map((field) => {
        if (field.key !== key || field.kind === "unsupported" || field.kind === "secret") {
          return field;
        }
        return updateFieldValue(field, value);
      }),
    },
  };
}

export function canAcceptMcpElicitation(
  state: PendingMcpInteractionState
): boolean {
  if (state.mode === "url") {
    return Boolean(state.url?.url) && !state.url?.blockedReason;
  }
  if (!state.form) {
    return false;
  }
  return state.form.fields.every(fieldIsValid);
}

export function buildMcpElicitationResponse(
  state: PendingMcpInteractionState,
  action: "accept" | "decline" | "cancel",
  persist?: McpApprovalPersistence,
): AppServerMcpElicitationResponse {
  if (action !== "accept") {
    return {
      action,
      content: null,
      _meta: null,
    };
  }

  if (state.mode === "url") {
    if (persist) {
      throw new Error("This MCP request does not support approval persistence.");
    }
    return {
      action,
      content: {},
      _meta: null,
    };
  }

  if (persist && !readMcpApprovalPersistence(state).includes(persist)) {
    throw new Error("This MCP request does not support the selected approval persistence.");
  }

  return {
    action,
    content: Object.fromEntries(
      state.form?.fields
        .flatMap((field) => field.kind === "unsupported" || field.kind === "secret"
          ? []
          : [[field.key, fieldContentValue(field)] as const]) ?? []
    ),
    _meta: persist ? { persist } : null,
  };
}

export function redactDisplayValue(
  value: unknown,
  context: { key?: string; label?: string } = {},
): string {
  if (isSecretFieldName(context.key ?? "") || isSecretFieldLabel(context.label ?? "")) return "[redacted]";
  if (typeof value === "string") {
    // Gateway approvals can carry serialized JSON; native Codex approvals
    // can carry the same argument as an object. Redact both structures alike.
    if (/^\s*[\[{]/.test(value)) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (parsed && typeof parsed === "object") return redactDisplayValue(parsed, context);
      } catch {
        // Ordinary text that happens to begin with a bracket.
      }
    }
    return redactDisplayString(value, context.key);
  }
  if (value && typeof value === "object") {
    return JSON.stringify(value, (key, current: unknown) => {
      if (key && (isSecretFieldName(key) || isSecretFieldLabel(key))) return "[redacted]";
      return typeof current === "string" ? redactDisplayString(current, key) : current;
    }, 2);
  }
  return String(value ?? "");
}

function redactDisplayString(value: string, key?: string): string {
  // A tool's display-name argument is not a credential merely because it is
  // long. Explicit bearer/credential assignments remain hidden in any field.
  if (looksSecret(value, key === "name")) return "[redacted]";
  return redactUrl(value);
}

function baseState(
  request: AppServerMcpElicitationRequestNotification,
  modeState: Pick<PendingMcpInteractionState, "form" | "url">
): PendingMcpInteractionState {
  return {
    method: request.method,
    requestId: request.params.requestId,
    threadId: request.params.threadId,
    turnId: request.params.turnId,
    serverName: request.params.serverName,
    message: request.params.message.trim(),
    mode: request.params.mode,
    purpose: mcpElicitationPurpose(request.params),
    _meta: asRecord(request.params._meta),
    ...modeState,
  };
}

function buildField(
  key: string,
  schema: Record<string, unknown>,
  required: boolean
): PendingMcpField {
  const label = trimString(schema.title) || key;
  const description = trimString(schema.description);

  if (isSecretField(key, label, schema)) {
    return { kind: "secret", key, label, description, required };
  }

  if (schema.type === "string") {
    const enumOptions = readStringOptions(schema);
    if (enumOptions.length > 0) {
      return {
        kind: "singleSelect",
        key,
        label,
        description,
        required,
        options: enumOptions,
        value: trimString(schema.default),
      };
    }

    return {
      kind: "string",
      key,
      label,
      description,
      required,
      minLength: readNumber(schema.minLength),
      maxLength: readNumber(schema.maxLength),
      ...(isStringFormat(schema.format) ? { format: schema.format } : {}),
      value: trimString(schema.default),
    };
  }

  if (schema.type === "number" || schema.type === "integer") {
    return {
      kind: "number",
      key,
      label,
      description,
      required,
      integer: schema.type === "integer",
      minimum: readNumber(schema.minimum),
      maximum: readNumber(schema.maximum),
      value: readNumber(schema.default) ?? null,
    };
  }

  if (schema.type === "boolean") {
    return {
      kind: "boolean",
      key,
      label,
      description,
      required,
      value: typeof schema.default === "boolean" ? schema.default : false,
    };
  }

  if (schema.type === "array") {
    const options = readArrayOptions(schema);
    if (options.length > 0) {
      return {
        kind: "multiSelect",
        key,
        label,
        description,
        required,
        options,
        minItems: readBigIntLike(schema.minItems),
        maxItems: readBigIntLike(schema.maxItems),
        value: Array.isArray(schema.default)
          ? schema.default.filter((entry): entry is string => typeof entry === "string")
          : [],
      };
    }
  }

  return {
    kind: "unsupported",
    key,
    label,
    description,
    required,
  };
}

function updateFieldValue(field: Exclude<PendingMcpField, { kind: "unsupported" | "secret" }>, value: FieldValue): PendingMcpField {
  if (field.kind === "string" && typeof value === "string") {
    return { ...field, value };
  }
  if (field.kind === "number" && (typeof value === "number" || value === null)) {
    return { ...field, value };
  }
  if (field.kind === "boolean" && typeof value === "boolean") {
    return { ...field, value };
  }
  if (field.kind === "singleSelect" && typeof value === "string") {
    return { ...field, value };
  }
  if (
    field.kind === "multiSelect" &&
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
  ) {
    return { ...field, value };
  }
  return field;
}

function fieldIsValid(field: PendingMcpField): boolean {
  if (field.kind === "secret") {
    return false;
  }
  if (field.kind === "unsupported") {
    return !field.required;
  }
  if (field.kind === "boolean") {
    return true;
  }
  if (field.kind === "number") {
    if (field.value == null) {
      return !field.required;
    }
    if (field.integer && !Number.isInteger(field.value)) {
      return false;
    }
    if (field.minimum != null && field.value < field.minimum) {
      return false;
    }
    if (field.maximum != null && field.value > field.maximum) {
      return false;
    }
    return true;
  }
  if (field.kind === "multiSelect") {
    if (field.required && field.value.length === 0) {
      return false;
    }
    if (field.minItems != null && field.value.length < field.minItems) {
      return false;
    }
    if (field.maxItems != null && field.value.length > field.maxItems) {
      return false;
    }
    return field.value.every((entry) =>
      field.options.some((option) => option.value === entry)
    );
  }

  const value = field.value.trim();
  if (field.required && !value) {
    return false;
  }
  if (field.kind === "string") {
    if (field.minLength != null && value.length < field.minLength) {
      return false;
    }
    if (field.maxLength != null && value.length > field.maxLength) {
      return false;
    }
    if (value && field.format && !matchesStringFormat(value, field.format)) {
      return false;
    }
  }
  if (field.kind === "singleSelect" && value) {
    return field.options.some((option) => option.value === value);
  }
  return true;
}

/** The message for a string field whose value does not match its format. */
export function mcpFieldFormatError(field: PendingMcpField): string | undefined {
  if (field.kind !== "string" || !field.format) {
    return undefined;
  }
  const value = field.value.trim();
  if (!value || matchesStringFormat(value, field.format)) {
    return undefined;
  }
  return STRING_FORMAT_ERRORS[field.format];
}

export function mcpFieldFormatPlaceholder(field: PendingMcpField): string | undefined {
  return field.kind === "string" && field.format ? STRING_FORMAT_PLACEHOLDERS[field.format] : undefined;
}

const STRING_FORMAT_ERRORS: Record<McpStringFormat, string> = {
  email: "Enter an email address.",
  uri: "Enter a full address, such as https://example.com.",
  date: "Enter a date as YYYY-MM-DD.",
  "date-time": "Enter a date and time as YYYY-MM-DDTHH:MM:SSZ.",
};

const STRING_FORMAT_PLACEHOLDERS: Record<McpStringFormat, string> = {
  email: "name@example.com",
  uri: "https://",
  date: "YYYY-MM-DD",
  "date-time": "YYYY-MM-DDTHH:MM:SSZ",
};

function isStringFormat(value: unknown): value is McpStringFormat {
  return value === "email" || value === "uri" || value === "date" || value === "date-time";
}

function matchesStringFormat(value: string, format: McpStringFormat): boolean {
  switch (format) {
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
    case "uri":
      return /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/u.test(value) && canParseUrl(value);
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/u.test(value) && isCalendarDate(value);
    case "date-time": {
      // RFC 3339: seconds and an offset are required.
      const match = /^(\d{4}-\d{2}-\d{2})[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/u.exec(value);
      return match !== null && isCalendarDate(match[1]!) && !Number.isNaN(Date.parse(value));
    }
  }
}

function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function canParseUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

// Only free text can carry a credential; a boolean or a fixed choice cannot.
function isSecretField(key: string, label: string, schema: Record<string, unknown>): boolean {
  if (schema.type !== "string" || readStringOptions(schema).length > 0) {
    return false;
  }
  return schema.format === "password"
    || schema.writeOnly === true
    || isSecretFieldName(key)
    || isSecretFieldName(label)
    || isSecretFieldLabel(label);
}

function readElicitationUrl(url: string, elicitationId: string): PendingMcpUrl {
  const base = {
    url,
    ...(elicitationId ? { elicitationId } : {}),
  };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      ...base, fullUrl: url, host: "", internationalHost: false,
      blockedReason: "This is not a valid web address.",
    };
  }
  const host = parsed.hostname;
  const internationalHost = host.split(".").some((label) => label.toLowerCase().startsWith("xn--"));
  const loopback = host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";
  const blockedReason = parsed.username || parsed.password
    ? "This address carries a user name or password."
    : parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback)
      ? undefined
      : "PwrAgent opens only https addresses from MCP servers.";
  return { ...base, fullUrl: parsed.href, host, internationalHost, ...(blockedReason ? { blockedReason } : {}) };
}

function fieldContentValue(field: Exclude<PendingMcpField, { kind: "unsupported" | "secret" }>): unknown {
  // A formatted value was validated trimmed; send what was validated.
  if (field.kind === "string" && field.format) {
    return field.value.trim();
  }
  if (field.kind === "string" || field.kind === "singleSelect") {
    return field.value;
  }
  return field.value;
}

function readStringOptions(schema: Record<string, unknown>): PendingMcpFieldOption[] {
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.flatMap((entry) => {
      const record = asRecord(entry);
      const value = trimString(record?.const);
      if (!value) {
        return [];
      }
      return [{ value, label: trimString(record?.title) || value }];
    });
  }

  if (Array.isArray(schema.enum)) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    return schema.enum.flatMap((entry, index) => {
      if (typeof entry !== "string") {
        return [];
      }
      return [{ value: entry, label: trimString(names[index]) || entry }];
    });
  }

  return [];
}

function readArrayOptions(schema: Record<string, unknown>): PendingMcpFieldOption[] {
  const items = asRecord(schema.items);
  if (!items) {
    return [];
  }

  if (Array.isArray(items.anyOf)) {
    return items.anyOf.flatMap((entry) => {
      const record = asRecord(entry);
      const value = trimString(record?.const);
      if (!value) {
        return [];
      }
      return [{ value, label: trimString(record?.title) || value }];
    });
  }

  if (Array.isArray(items.enum)) {
    return items.enum.flatMap((entry) =>
      typeof entry === "string" ? [{ value: entry, label: entry }] : []
    );
  }

  return [];
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

function looksSecret(value: string, displayName = false): boolean {
  const trimmed = value.trim();
  return (
    /^bearer\s+/i.test(trimmed) ||
    (!displayName && /^[A-Za-z0-9_-]{32,}$/.test(trimmed)) ||
    /(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)=/i.test(trimmed)
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBigIntLike(value: unknown): number | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return readNumber(value);
}

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
