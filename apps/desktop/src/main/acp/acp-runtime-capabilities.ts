import type {
  BackendAcpRuntimeCapabilities,
  BackendAcpRuntimeConfigOption,
  BackendAcpRuntimeConfigOptionValue,
  BackendAcpRuntimeModel,
  BackendAcpRuntimeMode,
  BackendAcpSessionRuntimeState,
} from "@pwragent/shared";

export function normalizeAcpRuntimeCapabilities(params: {
  value: unknown;
  now: number;
  source: BackendAcpRuntimeCapabilities["source"];
  initialize?: BackendAcpRuntimeCapabilities;
}): BackendAcpRuntimeCapabilities | undefined {
  const record = asRecord(params.value);
  if (!record) {
    return params.initialize;
  }

  const configOptions = readConfigOptions(record.configOptions ?? record.config_options);
  const modes = readModes(record.modes);
  const models = readModels(record.models);
  const agentCapabilities = readAgentCapabilities(
    record.agentCapabilities ?? record.capabilities,
  );
  const agentInfo = readAgentInfo(record.agentInfo ?? record.agent_info);
  const protocolVersion =
    typeof record.protocolVersion === "number"
      ? record.protocolVersion
      : params.initialize?.protocolVersion;

  const hasRuntimeData =
    configOptions.length > 0 ||
    Boolean(modes) ||
    Boolean(models) ||
    Boolean(agentCapabilities) ||
    Boolean(agentInfo) ||
    typeof protocolVersion === "number";

  if (!hasRuntimeData && !params.initialize) {
    return undefined;
  }

  return {
    schemaVersion: 1,
    status: "discovered",
    discoveredAt: params.now,
    checkedAt: params.now,
    source: params.source,
    ...(typeof protocolVersion === "number" ? { protocolVersion } : {}),
    ...(agentInfo ?? params.initialize?.agentInfo
      ? { agentInfo: { ...params.initialize?.agentInfo, ...agentInfo } }
      : {}),
    ...(agentCapabilities ?? params.initialize?.agentCapabilities
      ? {
          agentCapabilities: {
            ...params.initialize?.agentCapabilities,
            ...agentCapabilities,
          },
        }
      : {}),
    ...(configOptions.length > 0
      ? { configOptions }
      : params.initialize?.configOptions
        ? { configOptions: params.initialize.configOptions }
        : {}),
    ...(modes ? { modes } : params.initialize?.modes ? { modes: params.initialize.modes } : {}),
    ...(models ? { models } : params.initialize?.models ? { models: params.initialize.models } : {}),
  };
}

export function acpSessionRuntimeStateFromCapabilities(
  capabilities: BackendAcpRuntimeCapabilities | undefined,
  now: number,
): BackendAcpSessionRuntimeState | undefined {
  if (!capabilities) {
    return undefined;
  }
  const configValues = Object.fromEntries(
    (capabilities.configOptions ?? [])
      .flatMap((option) =>
        typeof option.currentValue === "string"
          ? [[option.id, option.currentValue] as const]
          : [],
      ),
  );
  const state: BackendAcpSessionRuntimeState = {
    updatedAt: now,
    ...(Object.keys(configValues).length > 0 ? { configValues } : {}),
    ...(capabilities.modes?.currentModeId
      ? { currentModeId: capabilities.modes.currentModeId }
      : {}),
    ...(capabilities.models?.currentModelId
      ? { currentModelId: capabilities.models.currentModelId }
      : {}),
  };
  return Object.keys(state).length > 1 ? state : undefined;
}

export function acpSessionRuntimeStateFromUpdate(
  update: Record<string, unknown>,
  now: number,
): BackendAcpSessionRuntimeState | undefined {
  const kind = update.sessionUpdate ?? update.kind ?? update.type;
  if (kind === "agent_message_chunk") {
    const modeId = readModeUpdateMarker(update);
    return modeId ? { currentModeId: modeId, updatedAt: now } : undefined;
  }
  if (kind === "current_mode_update") {
    const currentModeId =
      readString(update, "currentModeId") ??
      readString(update, "modeId") ??
      readString(update, "id");
    return currentModeId ? { currentModeId, updatedAt: now } : undefined;
  }
  if (kind === "config_option_update") {
    const configOption = asRecord(update.configOption ?? update.config_option) ?? update;
    const id =
      readString(configOption, "id") ??
      readString(configOption, "configOptionId") ??
      readString(configOption, "configId");
    const value =
      readString(configOption, "currentValue") ??
      readString(configOption, "value");
    return id && value
      ? { configValues: { [id]: value }, updatedAt: now }
      : undefined;
  }
  return undefined;
}

function readModeUpdateMarker(update: Record<string, unknown>): string | undefined {
  const text = readString(update, "content") ?? readString(update, "text");
  const match = text?.trim().match(/^\[MODE_UPDATE\]\s*([A-Za-z0-9_-]+)\s*$/);
  return match?.[1];
}

function readConfigOptions(value: unknown): BackendAcpRuntimeConfigOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const record = asRecord(item);
    const id =
      readString(record, "id") ??
      readString(record, "configOptionId") ??
      readString(record, "configId");
    if (!record || !id) {
      return [];
    }
    const values = readConfigOptionValues(record.values ?? record.options);
    if (values.length === 0) {
      return [];
    }
    return [
      {
        id,
        label:
          readString(record, "name") ??
          readString(record, "label") ??
          readString(record, "title") ??
          id,
        description: readString(record, "description"),
        type: "select",
        category: readString(record, "category"),
        currentValue:
          readString(record, "currentValue") ??
          readString(record, "value"),
        values,
      } satisfies BackendAcpRuntimeConfigOption,
    ];
  });
}

function readConfigOptionValues(value: unknown): BackendAcpRuntimeConfigOptionValue[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const record = asRecord(item);
    const optionValue =
      readString(record, "value") ??
      readString(record, "id") ??
      readString(record, "optionId");
    if (!record || !optionValue) {
      return [];
    }
    return [
      {
        value: optionValue,
        label:
          readString(record, "name") ??
          readString(record, "label") ??
          readString(record, "title"),
        description: readString(record, "description"),
      },
    ];
  });
}

function readModes(value: unknown): BackendAcpRuntimeCapabilities["modes"] {
  const record = asRecord(value);
  const modes = Array.isArray(record?.availableModes)
    ? record.availableModes.flatMap(readMode)
    : [];
  return modes.length > 0
    ? {
        availableModes: modes,
        currentModeId: readString(record, "currentModeId"),
      }
    : undefined;
}

function readMode(value: unknown): BackendAcpRuntimeMode[] {
  const record = asRecord(value);
  const id = readString(record, "id") ?? readString(record, "modeId");
  if (!record || !id) {
    return [];
  }
  return [
    {
      id,
      label: readString(record, "name") ?? readString(record, "label") ?? id,
      description: readString(record, "description"),
    },
  ];
}

function readModels(value: unknown): BackendAcpRuntimeCapabilities["models"] {
  const record = asRecord(value);
  const models = Array.isArray(record?.availableModels)
    ? record.availableModels.flatMap(readModel)
    : [];
  return models.length > 0
    ? {
        availableModels: models,
        currentModelId:
          readString(record, "currentModelId") ??
          readString(record, "modelId"),
      }
    : undefined;
}

function readModel(value: unknown): BackendAcpRuntimeModel[] {
  const record = asRecord(value);
  const id = readString(record, "modelId") ?? readString(record, "id");
  if (!record || !id) {
    return [];
  }
  return [
    {
      id,
      label: readString(record, "name") ?? readString(record, "label"),
      description: readString(record, "description"),
    },
  ];
}

function readAgentCapabilities(
  value: unknown,
): BackendAcpRuntimeCapabilities["agentCapabilities"] {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const loadSession =
    readBoolean(record, "loadSession") ?? readBoolean(asRecord(record.session), "load");
  const close = readBoolean(asRecord(record.session), "close");
  const cancel = readBoolean(asRecord(record.session), "cancel");
  const hasData =
    loadSession !== undefined || close !== undefined || cancel !== undefined;
  return hasData
    ? {
        ...(loadSession !== undefined ? { loadSession } : {}),
        ...(close !== undefined || cancel !== undefined
          ? { session: { ...(close !== undefined ? { close } : {}), ...(cancel !== undefined ? { cancel } : {}) } }
          : {}),
        raw: record,
      }
    : { raw: record };
}

function readAgentInfo(value: unknown): BackendAcpRuntimeCapabilities["agentInfo"] {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const agentInfo = {
    name: readString(record, "name"),
    title: readString(record, "title"),
    version: readString(record, "version"),
  };
  return Object.values(agentInfo).some((item) => item !== undefined)
    ? agentInfo
    : undefined;
}

function readString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readBoolean(
  record: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
