import type { AppServerTurnInputItem } from "../app-server/protocol.js";
import type { ToolDescriptor } from "../tools/tool-contract.js";

export type XaiResponsesClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  model?: string;
};

export type XaiResponseCreateRequest = {
  model?: string;
  input: Array<Record<string, unknown>>;
  previousResponseId?: string;
  tools?: XaiFunctionTool[];
  parallelToolCalls?: boolean;
  signal?: AbortSignal;
};

export type XaiFunctionTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export class XaiResponsesClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultModel?: string;

  constructor(options: XaiResponsesClientOptions) {
    this.apiKey = options.apiKey.trim();
    this.baseUrl = (options.baseUrl ?? "https://api.x.ai/v1").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.defaultModel = options.model?.trim() || undefined;
  }

  buildCreatePayload(params: XaiResponseCreateRequest): Record<string, unknown> {
    if (params.input.length === 0) {
      throw new Error("xAI responses require at least one input item");
    }
    return {
      model: params.model ?? this.defaultModel ?? "grok-4.20-reasoning",
      input: params.input,
      ...(params.previousResponseId
        ? { previous_response_id: params.previousResponseId }
        : {}),
      ...(params.tools?.length ? { tools: params.tools } : {}),
      ...(typeof params.parallelToolCalls === "boolean"
        ? { parallel_tool_calls: params.parallelToolCalls }
        : {}),
      stream: false,
    };
  }

  async createResponse(params: XaiResponseCreateRequest): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(this.buildCreatePayload(params)),
      signal: params.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`xAI Responses API request failed (${response.status}): ${body.trim()}`);
    }
    return await response.json();
  }
}

export function buildXaiFunctionTools(
  tools: ToolDescriptor[],
): XaiFunctionTool[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: {
      type: tool.inputSchema.type,
      properties: tool.inputSchema.properties,
      ...(tool.inputSchema.required?.length
        ? { required: tool.inputSchema.required }
        : {}),
      ...(typeof tool.inputSchema.additionalProperties === "boolean"
        ? { additionalProperties: tool.inputSchema.additionalProperties }
        : {}),
    },
  }));
}

export function buildFunctionCallOutputInput(
  callId: string,
  output: unknown,
): Record<string, unknown> {
  return {
    type: "function_call_output",
    call_id: callId,
    output,
  };
}

export function buildXaiInput(items: AppServerTurnInputItem[]): Array<Record<string, unknown>> {
  return items.map((item) => {
    if (item.type === "text") {
      return {
        role: "user",
        content: [{ type: "input_text", text: item.text }],
      };
    }
    if (item.type === "image") {
      return {
        role: "user",
        content: [{ type: "input_image", image_url: item.url }],
      };
    }
    return {
      role: "user",
      content: [{ type: "input_image", image_url: `file://${item.path}` }],
    };
  });
}
