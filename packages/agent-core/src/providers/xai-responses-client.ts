import { readFile } from "node:fs/promises";
import path from "node:path";
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
  promptCacheKey?: string;
  headers?: Record<string, string>;
  text?: {
    format: {
      type: "json_schema";
      name: string;
      schema: Record<string, unknown>;
      strict?: boolean;
    };
  };
  tools?: XaiTool[];
  parallelToolCalls?: boolean;
  signal?: AbortSignal;
};

export type XaiTool = XaiFunctionTool | XaiServerTool;

export type XaiFunctionTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type XaiServerTool = {
  type: "x_search" | "web_search";
  allowed_x_handles?: string[];
  excluded_x_handles?: string[];
  allowed_domains?: string[];
  excluded_domains?: string[];
  from_date?: string;
  to_date?: string;
  enable_image_understanding?: boolean;
  enable_video_understanding?: boolean;
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
      ...(params.promptCacheKey ? { prompt_cache_key: params.promptCacheKey } : {}),
      ...(params.text ? { text: params.text } : {}),
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
        ...params.headers,
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

export async function buildXaiInput(
  items: AppServerTurnInputItem[],
): Promise<Array<Record<string, unknown>>> {
  return await Promise.all(items.map(async (item) => {
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
      content: [{ type: "input_image", image_url: await localImageToDataUrl(item.path) }],
    };
  }));
}

async function localImageToDataUrl(filePath: string): Promise<string> {
  const mediaType = mediaTypeForImagePath(filePath);
  const data = await readFile(filePath);
  return `data:${mediaType};base64,${data.toString("base64")}`;
}

function mediaTypeForImagePath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    default:
      throw new Error(`Unsupported local image type for ${filePath}`);
  }
}
