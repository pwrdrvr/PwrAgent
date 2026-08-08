export type EphemeralObjectResult = {
  object: unknown;
  cachedTokens?: number;
};

export type EphemeralObjectCallRequest = {
  backend?: "codex";
  model?: string;
  schema: Record<string, unknown>;
  schemaName?: string;
  system: string;
  prompt: string;
  timeoutMs?: number;
};

export type ObjectClientLike = {
  generateObject(
    request: EphemeralObjectCallRequest,
  ): Promise<EphemeralObjectResult>;
};

export type EphemeralObjectCallResult =
  | {
      status: "ok";
      response: EphemeralObjectResult;
    }
  | {
      status: "unavailable";
      reason: string;
    }
  | {
      status: "failed";
      reason: string;
    };

export type EphemeralObjectCallerOptions = {
  client?: ObjectClientLike;
};

export class EphemeralObjectCaller {
  private readonly configuredClient?: ObjectClientLike;

  constructor(options: EphemeralObjectCallerOptions = {}) {
    this.configuredClient = options.client;
  }

  async generateObject(
    request: EphemeralObjectCallRequest
  ): Promise<EphemeralObjectCallResult> {
    const client = this.configuredClient;
    if (!client) {
      return {
        status: "unavailable",
        reason: "structured_generation_unavailable",
      };
    }

    try {
      const response = await client.generateObject({
        backend: request.backend,
        model: request.model,
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
