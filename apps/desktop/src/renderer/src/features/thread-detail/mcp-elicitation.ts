import type {
  AppServerMcpElicitationRequestNotification,
  AppServerMcpElicitationResponse,
} from "@pwragent/shared";

export type PendingMcpFieldOption = {
  value: string;
  label: string;
};

export type PendingMcpField =
  | {
      kind: "string";
      key: string;
      label: string;
      description: string;
      required: boolean;
      minLength?: number;
      maxLength?: number;
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
    };

export type PendingMcpInteractionState = {
  method: "mcpServer/elicitation/request";
  requestId: string;
  threadId: string;
  turnId?: string | null;
  serverName: string;
  message: string;
  mode: "form" | "url";
  _meta: Record<string, unknown> | null;
  form: {
    empty: boolean;
    fields: PendingMcpField[];
  } | null;
  url: {
    url: string;
    displayUrl: string;
    elicitationId: string;
  } | null;
};

type FieldValue = string | number | boolean | string[] | null;

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
    const elicitationId = trimString(request.params.elicitationId);
    if (!url || !elicitationId) {
      return undefined;
    }

    return baseState(request, {
      form: null,
      url: {
        url,
        displayUrl: redactUrl(url),
        elicitationId,
      },
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
        if (field.key !== key || field.kind === "unsupported") {
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
    return Boolean(state.url?.url);
  }
  if (!state.form) {
    return false;
  }
  return state.form.fields.every(fieldIsValid);
}

export function buildMcpElicitationResponse(
  state: PendingMcpInteractionState,
  action: "accept" | "decline" | "cancel"
): AppServerMcpElicitationResponse {
  if (action !== "accept") {
    return {
      action,
      content: null,
      _meta: null,
    };
  }

  if (state.mode === "url") {
    return {
      action,
      content: {},
      _meta: null,
    };
  }

  return {
    action,
    content: Object.fromEntries(
      state.form?.fields
        .filter((field) => field.kind !== "unsupported")
        .map((field) => [field.key, fieldContentValue(field)]) ?? []
    ),
    _meta: null,
  };
}

export function redactDisplayValue(value: unknown): string {
  if (typeof value !== "string") {
    return String(value ?? "");
  }

  if (looksSecret(value)) {
    return "[redacted]";
  }

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

function updateFieldValue(field: Exclude<PendingMcpField, { kind: "unsupported" }>, value: FieldValue): PendingMcpField {
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
  }
  if (field.kind === "singleSelect" && value) {
    return field.options.some((option) => option.value === value);
  }
  return true;
}

function fieldContentValue(field: Exclude<PendingMcpField, { kind: "unsupported" }>): unknown {
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

function looksSecret(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^bearer\s+/i.test(trimmed) ||
    /^[A-Za-z0-9_-]{32,}$/.test(trimmed) ||
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
