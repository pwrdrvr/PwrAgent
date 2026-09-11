import { homedir } from "node:os";
import { isAbsolute, parse, resolve } from "node:path";
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
  configureHelperSession?: (params: {
    client: AcpRuntimeClient;
    parentSession?: AcpSessionMetadata;
    reasoningEffort?: string;
    session: AcpSessionMetadata;
  }) => Promise<void>;
  helperSession?: {
    mcpServers?: "default" | "none";
    reasoningEffort?: string;
    sessionMeta?: Record<string, unknown>;
  };
  getClient: (backend: AcpBackendId) => Promise<AcpRuntimeClient>;
  getSession: (
    backend: AcpBackendId,
    threadId: string,
  ) => AcpSessionMetadata | undefined;
};

export class AcpThreadTitleGenerator implements ThreadTitleGenerator {
  private readonly backend: AcpBackendId;
  private readonly configureHelperSession?: (params: {
    client: AcpRuntimeClient;
    parentSession?: AcpSessionMetadata;
    reasoningEffort?: string;
    session: AcpSessionMetadata;
  }) => Promise<void>;
  private readonly helperSession?: AcpThreadTitleGeneratorOptions["helperSession"];
  private readonly getClient: (backend: AcpBackendId) => Promise<AcpRuntimeClient>;
  private readonly getSession: (
    backend: AcpBackendId,
    threadId: string,
  ) => AcpSessionMetadata | undefined;

  constructor(options: AcpThreadTitleGeneratorOptions) {
    this.backend = options.backend;
    this.configureHelperSession = options.configureHelperSession;
    this.helperSession = options.helperSession;
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

    try {
      const parentSession = this.getSession(this.backend, threadId);
      const cwd = parentSession?.cwd;
      if (
        !cwd
        || !isAbsolute(cwd)
        || resolve(cwd) === resolve(homedir())
        || resolve(cwd) === parse(cwd).root
      ) {
        return {
          status: "unavailable",
          reason: `${this.backend}_title_generator_workspace_missing`,
        };
      }
      const client = await this.getClient(this.backend);
      if (!client.sendControlPrompt) {
        return {
          status: "unavailable",
          reason: `${this.backend}_title_generator_unavailable`,
        };
      }
      // Carry model selection, never the parent's permission mode or other
      // runtime options (which can include auto-approval settings).
      const model = resolveAcpTitleModel(parentSession?.acpRuntime);
      const helperSession = await client.startSession({
        cwd,
        executionMode: "default",
        approvalPolicy: "deny-all",
        title: "Name this thread",
        ...(model ? { acpRuntime: { currentModelId: model } } : {}),
        hidden: true,
        mcpServers: this.helperSession?.mcpServers ?? "none",
        ...(this.helperSession?.sessionMeta
          ? { sessionMeta: this.helperSession.sessionMeta }
          : {}),
      });
      await this.configureHelperSession?.({
        client,
        parentSession,
        reasoningEffort: this.helperSession?.reasoningEffort,
        session: helperSession,
      });
      const response = await client.sendControlPrompt({
        sessionId: helperSession.sessionId,
        prompt: params.prompt,
      });
      const helperModel = resolveAcpTitleModel(
        helperSession.acpRuntime ?? parentSession?.acpRuntime,
      );
      const usageModel = response.model ?? helperModel;
      return {
        status: "ok",
        object: parseAcpTitleObject(response.text),
        helperThreadId: helperSession.sessionId,
        ...(usageModel ? { model: usageModel } : {}),
        ...(this.helperSession?.reasoningEffort
          ? { reasoningEffort: this.helperSession.reasoningEffort }
          : {}),
        ...(response.tokenUsage ? { tokenUsage: response.tokenUsage } : {}),
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

  // A prose answer means the helper performed the source task instead of
  // naming it. Let validation reject it and use the prompt-derived fallback.
  return {};
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
