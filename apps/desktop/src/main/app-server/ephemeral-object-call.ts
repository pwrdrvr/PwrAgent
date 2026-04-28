import {
  resolveGrokAppServerRuntimeConfig,
  XaiAiSdkObjectClient,
  type GrokAppServerRuntimeConfig,
  type XaiAiSdkObjectResult,
} from "@pwragnt/agent-core";

export type XaiObjectClientLike = Pick<XaiAiSdkObjectClient, "generateObject">;

export type XaiEphemeralObjectCallRequest = {
  model?: string;
  promptCacheKey?: string;
  headers?: Record<string, string>;
  schema: Record<string, unknown>;
  schemaName?: string;
  system: string;
  prompt: string;
  timeoutMs?: number;
};

export type XaiEphemeralObjectCallResult =
  | {
      status: "ok";
      response: XaiAiSdkObjectResult;
    }
  | {
      status: "unavailable";
      reason: string;
    }
  | {
      status: "failed";
      reason: string;
    };

export type XaiEphemeralObjectCallerOptions = {
  apiKey?: string;
  baseUrl?: string;
  client?: XaiObjectClientLike;
  model?: string;
  resolveRuntimeConfig?: () => GrokAppServerRuntimeConfig;
};

export class XaiEphemeralObjectCaller {
  private readonly configuredApiKey?: string;
  private readonly configuredBaseUrl?: string;
  private readonly configuredClient?: XaiObjectClientLike;
  private readonly configuredModel?: string;
  private readonly resolveRuntimeConfig: () => GrokAppServerRuntimeConfig;
  private envClient: XaiObjectClientLike | null | undefined;
  private runtimeConfig: GrokAppServerRuntimeConfig | undefined;

  constructor(options: XaiEphemeralObjectCallerOptions = {}) {
    this.configuredApiKey = options.apiKey?.trim() || undefined;
    this.configuredBaseUrl = options.baseUrl?.trim() || undefined;
    this.configuredClient = options.client;
    this.configuredModel = options.model?.trim() || undefined;
    this.resolveRuntimeConfig = options.resolveRuntimeConfig ?? resolveGrokAppServerRuntimeConfig;
  }

  async generateObject(
    request: XaiEphemeralObjectCallRequest
  ): Promise<XaiEphemeralObjectCallResult> {
    const client = this.getClient();
    if (!client) {
      return {
        status: "unavailable",
        reason: "xai_unavailable",
      };
    }

    const controller = new AbortController();
    const timeoutHandle =
      request.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            controller.abort();
          }, request.timeoutMs);

    try {
      const response = await client.generateObject({
        model: request.model?.trim() || this.configuredModel,
        promptCacheKey: request.promptCacheKey,
        headers: request.headers,
        signal: controller.signal,
        schema: request.schema,
        schemaName: request.schemaName,
        system: request.system,
        prompt: request.prompt,
      });
      return {
        status: "ok",
        response,
      };
    } catch (error) {
      return {
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private getClient(): XaiObjectClientLike | null {
    if (this.configuredClient) {
      return this.configuredClient;
    }

    if (this.envClient !== undefined) {
      return this.envClient;
    }

    const runtimeConfig = this.getRuntimeConfig();
    const apiKey = this.configuredApiKey ?? runtimeConfig.apiKey;
    if (!apiKey) {
      this.envClient = null;
      return this.envClient;
    }

    this.envClient = new XaiAiSdkObjectClient({
      apiKey,
      baseUrl: this.configuredBaseUrl ?? runtimeConfig.baseUrl,
      model: this.configuredModel,
    });

    return this.envClient;
  }

  private getRuntimeConfig(): GrokAppServerRuntimeConfig {
    if (this.runtimeConfig) {
      return this.runtimeConfig;
    }

    this.runtimeConfig = this.resolveRuntimeConfig();
    return this.runtimeConfig;
  }
}
