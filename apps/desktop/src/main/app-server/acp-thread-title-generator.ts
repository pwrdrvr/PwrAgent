import type {
  AcpBackendId,
  BackendAcpSessionRuntimeState,
} from "@pwragent/shared";
import type { AcpRuntimeClient, AcpSessionMetadata } from "./acp-backend-adapter";
import type {
  ThreadTitleAdapterParams,
  ThreadTitleAdapterResult,
  ThreadTitleGenerator,
} from "./thread-title-generation-service";

export type AcpThreadTitleGeneratorOptions = {
  backend: AcpBackendId;
  getClient: (backend: AcpBackendId) => Promise<AcpRuntimeClient>;
  getSession: (
    backend: AcpBackendId,
    threadId: string,
  ) => AcpSessionMetadata | undefined;
};

export class AcpThreadTitleGenerator implements ThreadTitleGenerator {
  private readonly backend: AcpBackendId;
  private readonly getClient: (backend: AcpBackendId) => Promise<AcpRuntimeClient>;
  private readonly getSession: (
    backend: AcpBackendId,
    threadId: string,
  ) => AcpSessionMetadata | undefined;

  constructor(options: AcpThreadTitleGeneratorOptions) {
    this.backend = options.backend;
    this.getClient = options.getClient;
    this.getSession = options.getSession;
  }

  async generateTitle(
    params: ThreadTitleAdapterParams,
  ): Promise<ThreadTitleAdapterResult> {
    const threadId = params.threadId?.trim();
    if (!threadId) {
      return {
        status: "unavailable",
        reason: `${this.backend}_title_generator_thread_missing`,
      };
    }

    const client = await this.getClient(this.backend);
    if (!client.sendControlPrompt) {
      return {
        status: "unavailable",
        reason: `${this.backend}_title_generator_unavailable`,
      };
    }

    try {
      const response = await client.sendControlPrompt({
        sessionId: threadId,
        prompt: params.prompt,
      });
      const model = resolveAcpTitleModel(
        this.getSession(this.backend, threadId)?.acpRuntime,
      );
      return {
        status: "ok",
        object: parseAcpTitleObject(response.text),
        ...(model ? { model } : {}),
      };
    } catch {
      return {
        status: "failed",
        reason: `${this.backend}_title_generator_failed`,
      };
    }
  }
}

function parseAcpTitleObject(text: string): unknown {
  const trimmed = stripMarkdownFence(text.trim());
  if (!trimmed) {
    return {};
  }

  const jsonObject = extractJsonObject(trimmed);
  const parsed =
    tryParseJson(trimmed) ??
    tryParseJson(escapeNewlinesInsideJsonStrings(trimmed)) ??
    tryParseJson(jsonObject) ??
    tryParseJson(escapeNewlinesInsideJsonStrings(jsonObject));
  if (parsed) {
    return parsed;
  }

  return { title: trimmed };
}

function stripMarkdownFence(text: string): string {
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1]?.trim() ?? "" : text;
}

function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return "";
  }
  return text.slice(start, end + 1);
}

function tryParseJson(text: string): unknown | undefined {
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function escapeNewlinesInsideJsonStrings(text: string): string {
  let escaped = "";
  let inString = false;
  let escapedPrevious = false;

  for (const char of text) {
    if (inString && (char === "\n" || char === "\r")) {
      if (!escaped.endsWith(" ")) {
        escaped += " ";
      }
      escapedPrevious = false;
      continue;
    }
    escaped += char;
    if (escapedPrevious) {
      escapedPrevious = false;
      continue;
    }
    if (char === "\\") {
      escapedPrevious = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
    }
  }

  return escaped;
}

function resolveAcpTitleModel(
  runtime: BackendAcpSessionRuntimeState | undefined,
): string | undefined {
  return runtime?.currentModelId ?? runtime?.configValues?.model;
}
