export type XaiAiSdkObjectResult = {
  object: unknown;
  cachedTokens?: number;
};

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

export type XaiObjectClientLike = {
  generateObject(
    request: XaiEphemeralObjectCallRequest,
  ): Promise<XaiAiSdkObjectResult>;
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
  client?: XaiObjectClientLike;
};

export class XaiEphemeralObjectCaller {
  private readonly configuredClient?: XaiObjectClientLike;

  constructor(options: XaiEphemeralObjectCallerOptions = {}) {
    this.configuredClient = options.client;
  }

  async generateObject(
    request: XaiEphemeralObjectCallRequest
  ): Promise<XaiEphemeralObjectCallResult> {
    const client = this.configuredClient;
    if (!client) {
      return {
        status: "unavailable",
        reason: "xai_unavailable",
      };
    }

    try {
      const response = await client.generateObject({
        model: request.model?.trim() || undefined,
        promptCacheKey: request.promptCacheKey,
        headers: request.headers,
        schema: request.schema,
        schemaName: request.schemaName,
        system: request.system,
        prompt: request.prompt,
        timeoutMs: request.timeoutMs,
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
    }
  }
}
