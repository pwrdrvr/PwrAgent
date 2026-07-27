import {
  AppServerSessionState,
  CodexAppServer,
  GrokProvider,
  GrokRolloutStore,
  XaiAiSdkObjectClient,
  loadLocalEnv,
  resolveGrokAppServerRuntimeConfig,
} from "@pwragent/agent-core";

export const GROK_GENERATE_OBJECT_METHOD = "pwragent/xai/generateObject";
export const GROK_SHUTDOWN_METHOD = "shutdown";
const PROFILE_STATE_ROOT_ENV = "PWRAGENT_GROK_PROFILE_STATE_ROOT";
const LOCAL_ENV_PATH_ENV = "PWRAGENT_GROK_LOCAL_ENV_PATH";

type NotificationHandler = (
  notification: {
    method: string;
    params?: Record<string, unknown>;
  },
) => void | Promise<void>;

type RequestHandler = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown> | unknown;

export type ProcessAppServer = {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  onNotification(handler: NotificationHandler): () => void;
  onRequest(handler: RequestHandler): () => void;
  shouldShutdown(): boolean;
};

type GenerateObjectRequest = {
  model?: string;
  promptCacheKey?: string;
  headers?: Record<string, string>;
  schema: Record<string, unknown>;
  schemaName?: string;
  system: string;
  prompt: string;
  timeoutMs?: number;
};

export function createProcessAppServer(
  env: NodeJS.ProcessEnv = process.env,
): ProcessAppServer {
  const localEnvPath = env[LOCAL_ENV_PATH_ENV]?.trim();
  if (localEnvPath) {
    loadLocalEnv({
      env,
      envPath: localEnvPath,
      override: false,
    });
  }
  const runtimeConfig = resolveGrokAppServerRuntimeConfig({
    env,
    profileStateRoot: env[PROFILE_STATE_ROOT_ENV],
  });
  const apiKey = runtimeConfig.apiKey?.trim();
  if (!apiKey) {
    throw new Error("Grok API key is not set");
  }

  const provider = new GrokProvider({
    apiKey,
    baseUrl: runtimeConfig.baseUrl,
    model: runtimeConfig.model,
  });
  const objectClient = new XaiAiSdkObjectClient({
    apiKey,
    baseUrl: runtimeConfig.baseUrl,
    model: runtimeConfig.model,
  });
  const server = new CodexAppServer({
    provider,
    sessionState: new AppServerSessionState({
      store: new GrokRolloutStore(runtimeConfig.stateRoot),
    }),
  });
  let shutdownRequested = false;

  return {
    request: async (method, params) => {
      if (method === GROK_SHUTDOWN_METHOD) {
        shutdownRequested = true;
        return {};
      }
      if (method === GROK_GENERATE_OBJECT_METHOD) {
        return await generateObject(objectClient, params);
      }
      return await server.request(method, params);
    },
    notify: async (method, params) => {
      await server.notify(method, params);
    },
    onNotification: (handler) => server.onNotification(handler),
    onRequest: (handler) => server.onRequest(handler),
    shouldShutdown: () => shutdownRequested,
  };
}

async function generateObject(
  client: XaiAiSdkObjectClient,
  value: unknown,
): Promise<unknown> {
  const request = readGenerateObjectRequest(value);
  const controller = new AbortController();
  const timeoutHandle =
    request.timeoutMs === undefined
      ? undefined
      : setTimeout(() => controller.abort(), Math.max(0, request.timeoutMs));

  try {
    return await client.generateObject({
      model: request.model,
      promptCacheKey: request.promptCacheKey,
      headers: request.headers,
      signal: controller.signal,
      schema: request.schema,
      schemaName: request.schemaName,
      system: request.system,
      prompt: request.prompt,
    });
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function readGenerateObjectRequest(value: unknown): GenerateObjectRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("generateObject params must be an object");
  }
  const record = value as Record<string, unknown>;
  const schema = readRecord(record.schema, "schema");
  const system = readRequiredString(record.system, "system");
  const prompt = readRequiredString(record.prompt, "prompt");

  return {
    schema,
    system,
    prompt,
    ...(readOptionalString(record.model) ? { model: readOptionalString(record.model) } : {}),
    ...(readOptionalString(record.promptCacheKey)
      ? { promptCacheKey: readOptionalString(record.promptCacheKey) }
      : {}),
    ...(readOptionalString(record.schemaName)
      ? { schemaName: readOptionalString(record.schemaName) }
      : {}),
    ...(record.headers === undefined
      ? {}
      : { headers: readStringRecord(record.headers, "headers") }),
    ...(typeof record.timeoutMs === "number" && Number.isFinite(record.timeoutMs)
      ? { timeoutMs: Math.max(0, record.timeoutMs) }
      : {}),
  };
}

function readRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readStringRecord(value: unknown, name: string): Record<string, string> {
  const record = readRecord(value, name);
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string") {
      throw new Error(`${name}.${key} must be a string`);
    }
    output[key] = entry;
  }
  return output;
}

function readRequiredString(value: unknown, name: string): string {
  const normalized = readOptionalString(value);
  if (!normalized) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return normalized;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
