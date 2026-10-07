import { homedir } from "node:os";
import { isAbsolute, parse, resolve } from "node:path";
import type {
  AcpBackendId,
  BackendAcpSessionRuntimeState,
} from "@pwragent/shared";
import type { AcpRuntimeClient, AcpSessionMetadata } from "./acp-backend-adapter";
import { parseAcpJsonAnswer } from "./acp-json-answer";
import type {
  ThreadTitleAdapterParams,
  ThreadTitleAdapterResult,
  ThreadTitleGenerator,
} from "./thread-title-generation-service";

export type AcpThreadTitleGeneratorOptions = {
  backend: AcpBackendId;
  resolveUsageAccountKey?: () => Promise<string | undefined>;
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
  private readonly resolveUsageAccountKey?: () => Promise<string | undefined>;
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
    this.resolveUsageAccountKey = options.resolveUsageAccountKey;
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
      const accountKey = await this.resolveUsageAccountKey?.();
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
        ...(accountKey ? { accountKey } : {}),
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
  // A prose answer means the helper performed the source task instead of
  // naming it. Let validation reject it and use the prompt-derived fallback.
  return parseAcpJsonAnswer(text) ?? {};
}

function resolveAcpTitleModel(
  runtime: BackendAcpSessionRuntimeState | undefined,
): string | undefined {
  return runtime?.currentModelId ?? runtime?.configValues?.model;
}
