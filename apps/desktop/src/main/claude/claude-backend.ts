import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { query, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentEvent, AppServerPendingRequestNotification, AppServerThreadEntry,
  AppServerThreadMessageEntry, AppServerThreadMessagePart, AppServerThreadReplay, AppServerThreadSummary,
  AppServerTurnInputItem, BackendModelOption, BackendSummary, ThreadExecutionMode, CodexMcpServerSummary,
} from "@pwragent/shared";
import { resolveActiveProfilePath } from "../profile";
import { toTranscriptImageProtocolUrl } from "../transcript-image-protocol";
import { CLAUDE_SETUP_INSTRUCTIONS, claudeEnvironment, inspectClaudeInstallation, type ClaudeInstallation } from "./claude-executable";
import { createClaudePermissionHandler, claudePermissionMode } from "./claude-permissions";
import { claudeHarnessOptions, discoverClaudeModels } from "./claude-models";
import { claudeRateLimits, claudeStreamRateLimits, claudeTelemetry, claudeTurnUsage } from "./claude-usage";
import { ClaudeSessionStore, type ClaudeSession } from "./claude-session-store";

export type ClaudeBackendOptions = {
  store?: ClaudeSessionStore;
  query?: typeof query;
  inspectInstallation?: typeof inspectClaudeInstallation;
  discoverModels?: typeof discoverClaudeModels;
  resolveEnv?: () => Promise<NodeJS.ProcessEnv>;
  emit: (event: AgentEvent) => Promise<void>;
  request: (request: AppServerPendingRequestNotification, signal: AbortSignal) => Promise<unknown>;
  cancelRequest: (threadId: string, turnId: string, requestId: string) => Promise<void>;
};

type RunningTurn = {
  turnId: string;
  controller: AbortController;
  query?: Query;
  done?: Promise<void>;
  entries: Map<string, AppServerThreadEntry>;
  started?: boolean;
  contextWindow?: ClaudeSession["contextWindow"];
};

export class ClaudeBackend {
  private readonly store: ClaudeSessionStore;
  private readonly running = new Map<string, RunningTurn>();
  private installation: ClaudeInstallation = { authStatus: "unknown", message: CLAUDE_SETUP_INSTRUCTIONS };
  private discovery?: Promise<void>;
  private models?: BackendModelOption[];
  private rateLimits: BackendSummary["rateLimits"];

  constructor(private readonly options: ClaudeBackendOptions) {
    this.store = options.store ?? new ClaudeSessionStore(path.join(resolveActiveProfilePath("state"), "claude"));
  }

  async discover(options: { models?: boolean } = {}): Promise<void> {
    if (this.discovery) return this.discovery;
    this.discovery = (async () => {
      const env = claudeEnvironment(await this.options.resolveEnv?.() ?? process.env);
      this.installation = await (this.options.inspectInstallation ?? inspectClaudeInstallation)({ env });
      if (options.models !== false && this.installation.executable && this.installation.authStatus !== "sign-in-required") {
        this.models = await (this.options.discoverModels ?? discoverClaudeModels)({
          executable: this.installation.executable, env,
        });
      }
    })();
    try { await this.discovery; } finally { this.discovery = undefined; }
  }

  summary(): BackendSummary {
    const available = Boolean(this.installation.executable) && this.installation.authStatus !== "sign-in-required";
    return {
      kind: "claude", source: "builtin", label: "Claude", available,
      claude: { ...this.installation },
      rateLimits: this.rateLimits,
      unavailableReason: available ? undefined : this.installation.message,
      methods: [],
      capabilities: {
        listThreads: true, createThread: true, resumeThread: true, renameThread: true,
        readThread: true, startTurn: true, interruptTurn: true, steerTurn: false,
        archiveThread: true, restoreThread: true, archiveWorktree: false,
        transcriptPagination: false, toolUse: true, approvalRequests: true,
        multiDirectoryThreads: false,
      },
      executionModes: [
        { mode: "default", label: "Default", available: true, isDefault: true },
        { mode: "auto", label: "Auto", available: true },
        { mode: "full-access", label: "Full Access", available: true },
      ],
      // Stable aliases remain usable before explicit Settings/setup discovery.
      launchpadOptions: { models: this.models ?? [
        { id: "sonnet", label: "Sonnet", supportsImage: true },
        { id: "opus", label: "Opus", supportsImage: true },
        { id: "haiku", label: "Haiku", supportsImage: true },
      ] },
    };
  }

  private async requireInstallation(): Promise<string> {
    await this.discover({ models: false });
    if (!this.installation.executable || this.installation.authStatus === "sign-in-required") {
      throw new Error(this.installation.message ?? CLAUDE_SETUP_INSTRUCTIONS);
    }
    return this.installation.executable;
  }

  async startThread(params: {
    cwd: string; model?: string; executionMode: ThreadExecutionMode;
    linkedDirectories?: AppServerThreadSummary["linkedDirectories"];
  }): Promise<{ threadId: string }> {
    await this.requireInstallation();
    const id = randomUUID();
    const now = Date.now();
    await this.store.save({
      cwd: params.cwd,
      thread: {
        id, source: "claude", title: "Untitled thread", titleSource: "fallback",
        createdAt: now, updatedAt: now, model: params.model, executionMode: params.executionMode,
        linkedDirectories: params.linkedDirectories ?? [{ id: params.cwd, kind: "local", label: path.basename(params.cwd), path: params.cwd }],
        workspaceHandoff: { available: false, unavailableReason: "Start a new Claude thread in the target workspace." },
      },
    });
    return { threadId: id };
  }

  async executionMode(threadId: string): Promise<ThreadExecutionMode> {
    return (await this.store.read(threadId)).thread.executionMode ?? "default";
  }

  async listThreads(params: { archived?: boolean; filter?: string } = {}): Promise<AppServerThreadSummary[]> {
    const filter = params.filter?.toLowerCase();
    return (await this.store.list()).map(({ thread }) => ({
      ...thread, threadStatus: this.running.has(thread.id) ? "active" as const : "idle" as const,
    })).filter((thread) => Boolean(thread.archivedAt) === Boolean(params.archived)
      && (!filter || thread.title.toLowerCase().includes(filter) || thread.id.includes(filter)));
  }

  async readThread(threadId: string): Promise<AppServerThreadReplay> {
    const session = await this.store.read(threadId);
    const entries = new Map((await this.store.entries(threadId)).map((entry) => [entry.id, entry]));
    for (const entry of this.running.get(threadId)?.entries.values() ?? []) entries.set(entry.id, entry);
    const ordered = [...entries.values()];
    const messages = ordered.filter((entry): entry is AppServerThreadMessageEntry => entry.type === "message");
    return {
      entries: ordered, messages,
      contextWindow: this.running.get(threadId)?.contextWindow ?? session.contextWindow,
      lastUserMessage: messages.findLast((entry) => entry.role === "user")?.text,
      lastAssistantMessage: messages.findLast((entry) => entry.role === "assistant")?.text,
      pagination: { supportsPagination: false, hasPreviousPage: false },
      threadStatus: this.running.has(threadId) ? "active" : "idle",
    };
  }

  async renameThread(threadId: string, name: string): Promise<{ threadId: string }> {
    const session = await this.store.read(threadId);
    session.thread.title = name.trim();
    session.thread.titleSource = "explicit";
    await this.store.save(session);
    return { threadId };
  }

  async setArchived(threadId: string, archived: boolean): Promise<void> {
    if (this.running.has(threadId)) throw new Error("Interrupt the active Claude turn before archiving.");
    const session = await this.store.read(threadId);
    session.thread.archivedAt = archived ? Date.now() : undefined;
    await this.store.save(session);
  }

  async setExecutionMode(threadId: string, mode: ThreadExecutionMode): Promise<void> {
    // Relaunching at the next turn applies the mode through the SDK. During a
    // live turn use its control API and wait for acknowledgement before saving.
    const running = this.running.get(threadId);
    if (running && !running.query) throw new Error("Claude is starting. Wait for the turn to start before changing permissions.");
    await running?.query?.setPermissionMode(claudePermissionMode(mode));
    const session = await this.store.read(threadId);
    session.thread.executionMode = mode;
    await this.store.save(session);
  }

  async startTurn(params: {
    threadId: string; input: AppServerTurnInputItem[]; model?: string; reasoningEffort?: string;
    executionMode?: ThreadExecutionMode; instructions?: string;
    mcpServers?: Options["mcpServers"];
    onTurnFinished?: () => void;
  }): Promise<{ backend: "claude"; threadId: string; turnId: string }> {
    if (this.running.has(params.threadId)) throw new Error("A Claude turn is already active for this thread.");
    const running: RunningTurn = { turnId: randomUUID(), controller: new AbortController(), entries: new Map() };
    this.running.set(params.threadId, running);
    try {
      const executable = await this.requireInstallation();
      const session = await this.store.read(params.threadId);
      if (session.thread.archivedAt) throw new Error("Restore this Claude thread before sending a message.");
      const content = await claudeInput(params.input);
      running.controller.signal.throwIfAborted();
      const parts = claudeUserMessageParts(params.input);
      const user: AppServerThreadMessageEntry = {
        type: "message", id: `user:${running.turnId}`, role: "user",
        text: parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n"),
        parts,
        createdAt: Date.now(), turn: { id: running.turnId, status: "in_progress" },
      };
      const firstPrompt = params.input.find((item) => item.type === "text" && item.text.trim());
      if (session.thread.titleSource === "fallback" && firstPrompt?.type === "text") {
        session.thread.title = firstPrompt.text.replace(/\s+/g, " ").trim().slice(0, 80);
        session.thread.titleSource = "derived";
        await this.store.save(session);
        await this.emit({ method: "thread/name/updated", params: {
          threadId: params.threadId, threadName: session.thread.title, titleSource: "derived",
        } });
      }
      running.entries.set(user.id, user);
      await this.store.append(params.threadId, [user]);
      running.started = true;
      await this.emit({ method: "turn/started", params: { threadId: params.threadId, turn: { id: running.turnId, status: "in_progress" } } });
      await this.emit({ method: "item/completed", params: {
        threadId: params.threadId, turnId: running.turnId,
        item: { id: user.id, type: "userMessage", text: user.text, content: parts },
      } });
      const env = claudeEnvironment(await this.options.resolveEnv?.() ?? process.env);
      this.rateLimits = undefined;
      const permissionMode = claudePermissionMode(params.executionMode ?? session.thread.executionMode ?? "default");
      const sdkOptions: Options = {
        ...claudeHarnessOptions(executable, env),
        cwd: session.cwd,
        ...(session.sdkSessionId ? { resume: session.sdkSessionId } : { sessionId: params.threadId }),
        systemPrompt: { type: "preset", preset: "claude_code", ...(params.instructions ? { append: params.instructions } : {}) },
        persistSession: true,
        includePartialMessages: true,
        permissionMode,
        // Enables an explicit Full Access selection through setPermissionMode;
        // the current permissionMode still governs every tool invocation.
        allowDangerouslySkipPermissions: true,
        model: params.model ?? session.thread.model,
        ...(["low", "medium", "high", "xhigh", "max"].includes(params.reasoningEffort ?? "")
          ? { effort: params.reasoningEffort as Options["effort"] } : {}),
        abortController: running.controller,
        mcpServers: params.mcpServers,
        canUseTool: createClaudePermissionHandler({
          threadId: params.threadId, turnId: running.turnId,
          request: this.options.request,
          cancelRequest: (requestId) => this.options.cancelRequest(params.threadId, running.turnId, requestId),
        }),
      };
      let releasePrompt!: () => void;
      const promptReady = new Promise<void>((resolve) => { releasePrompt = resolve; });
      async function* prompt(): AsyncIterable<SDKUserMessage> {
        await promptReady;
        yield { type: "user", session_id: session.sdkSessionId ?? params.threadId, parent_tool_use_id: null, message: { role: "user", content } };
      }
      running.query = (this.options.query ?? query)({ prompt: prompt(), options: sdkOptions });
      // Older PwrAgent metadata has no cost baseline. Read the official
      // session totals before releasing the prompt, so this turn cannot race
      // its own baseline. If unavailable, the first result seeds the next turn.
      try {
        if (session.sdkSessionId && !session.modelUsage) {
          const usage = await claudeTelemetry(() => running.query!.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }));
          if (usage?.session?.model_usage) session.modelUsage = usage.session.model_usage;
        }
      } finally { releasePrompt(); }
      running.done = this.consume(session, running).finally(params.onTurnFinished);
      // consume owns every error after launch, including terminal notification.
      void running.done.catch(() => {});
      return { backend: "claude", threadId: params.threadId, turnId: running.turnId };
    } catch (error) {
      this.running.delete(params.threadId);
      params.onTurnFinished?.();
      if (running.started) {
        for (const entry of running.entries.values()) entry.turn = { id: running.turnId, status: "failed" };
        await this.store.append(params.threadId, [...running.entries.values()]);
        await this.emit({ method: "turn/failed", params: {
          threadId: params.threadId, turnId: running.turnId,
          turn: { id: running.turnId, status: "failed", error: { message: error instanceof Error ? error.message : String(error) } },
        } });
      }
      throw error;
    }
  }

  private async emit(notification: AgentEvent["notification"]): Promise<void> {
    await this.options.emit({ backend: "claude", notification });
  }

  private async consume(session: ClaudeSession, running: RunningTurn): Promise<void> {
    const threadId = session.thread.id;
    const turnId = running.turnId;
    let messageId = "";
    let failure: string | undefined;
    let receivedResult = false;
    const needsUsageBaseline = Boolean(session.sdkSessionId) && !session.modelUsage;
    try {
      for await (const message of running.query!) {
        if (message.type === "system" && message.subtype === "init") {
          session.sdkSessionId = message.session_id;
          const current = await this.store.read(threadId);
          current.sdkSessionId = message.session_id;
          await this.store.save(current);
          await Promise.all([this.refreshUsage(running), this.refreshContext(session, running)]);
        }
        if (message.type === "stream_event" && !message.parent_tool_use_id) {
          const event = message.event;
          if (event.type === "message_start") messageId = event.message.id;
          if (event.type === "content_block_delta" && event.delta.type === "text_delta" && messageId) {
            const previous = running.entries.get(messageId);
            const entry: AppServerThreadMessageEntry = {
              type: "message", id: messageId, role: "assistant",
              text: (previous?.type === "message" ? previous.text : "") + event.delta.text,
              turn: { id: turnId, status: "in_progress" },
            };
            running.entries.set(messageId, entry);
            await this.emit({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: messageId, delta: event.delta.text } });
          }
        }
        if (message.type === "rate_limit_event") {
          const limits = new Map(this.rateLimits?.map((limit) => [limit.limitId, limit]));
          for (const limit of claudeStreamRateLimits(message.rate_limit_info)) limits.set(limit.limitId, limit);
          this.rateLimits = [...limits.values()];
          await this.emit({ method: "backend/providerStatus/updated", params: { backend: "claude" } });
        }
        await this.consumeCompleteMessage(message, threadId, running);
        if (message.type === "assistant" && !message.parent_tool_use_id) {
          await this.refreshContext(session, running);
        }
        if (message.type === "result") {
          receivedResult = true;
          const hasUsage = message.modelUsage && Object.values(message.modelUsage).some((value) =>
            value.inputTokens + value.outputTokens + value.cacheReadInputTokens + value.cacheCreationInputTokens > 0);
          if (hasUsage) {
            const canAttribute = !needsUsageBaseline || Boolean(session.modelUsage);
            const tokenUsage = claudeTurnUsage(message.modelUsage, session.modelUsage);
            session.modelUsage = message.modelUsage;
            // Without an old session's baseline, cumulative spend cannot be
            // attributed to this turn. Save it for the next turn, do not bill
            // the pre-existing transcript as new work.
            if (canAttribute) {
              await this.emit({ method: "thread/tokenUsage/updated", params: { threadId, turnId, model: tokenUsage.model, tokenUsage } });
            }
          }
          await Promise.all([this.refreshContext(session, running), this.refreshUsage(running)]);
          if (message.is_error) failure = message.subtype === "success" ? message.result : message.errors.join("\n");
          break;
        }
      }
      if (!receivedResult && !running.controller.signal.aborted) failure = "Claude exited before completing the turn.";
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      try { running.query?.close(); }
      catch (error) { failure ??= error instanceof Error ? error.message : String(error); }
      const cancelled = running.controller.signal.aborted;
      const status = cancelled ? "cancelled" : failure ? "failed" : "completed";
      for (const entry of running.entries.values()) {
        entry.turn = { id: turnId, status, completedAt: Date.now() };
      }
      try {
        await this.store.append(threadId, [...running.entries.values()]);
        // Re-read metadata so a live rename/mode change cannot be overwritten.
        const current = await this.store.read(threadId);
        current.sdkSessionId = session.sdkSessionId;
        current.modelUsage = session.modelUsage;
        current.contextWindow = session.contextWindow;
        current.thread.updatedAt = Date.now();
        await this.store.save(current);
      } catch (error) {
        failure = `Could not save Claude history: ${error instanceof Error ? error.message : String(error)}`;
      }
      this.running.delete(threadId);
      if (cancelled) {
        await this.emit({ method: "turn/cancelled", params: { threadId, turnId, turn: { id: turnId, status: "cancelled" } } });
      } else if (failure) {
        await this.emit({ method: "turn/failed", params: { threadId, turnId, turn: { id: turnId, status: "failed", error: { message: failure } } } });
      } else {
        await this.emit({ method: "turn/completed", params: { threadId, turnId, turn: {
          id: turnId, status: "completed",
          output: [...running.entries.values()].flatMap((entry) => entry.type === "message" && entry.role === "assistant" ? [{ type: "text" as const, text: entry.text }] : []),
        } } });
      }
    }
  }

  private async refreshUsage(running: RunningTurn) {
    const usage = await claudeTelemetry(() => running.query!.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }));
    // An unavailable optional probe must not erase windows observed on the
    // stream during this turn. A known non-subscription account does clear them.
    if (usage && (!usage.rate_limits_available || usage.rate_limits)) this.rateLimits = claudeRateLimits(usage);
    await this.emit({ method: "backend/providerStatus/updated", params: { backend: "claude" } });
    return usage;
  }

  private async refreshContext(session: ClaudeSession, running: RunningTurn): Promise<void> {
    const context = await claudeTelemetry(() => running.query!.getContextUsage({ detail: "summary" }));
    if (!context || !Number.isFinite(context.totalTokens) || !(context.totalTokens >= 0)
      || !Number.isFinite(context.maxTokens) || !(context.maxTokens > 0)) return;
    session.contextWindow = { usedTokens: context.totalTokens, modelContextWindow: context.maxTokens };
    running.contextWindow = session.contextWindow;
    await this.emit({ method: "thread/contextWindow/updated", params: {
      threadId: session.thread.id, turnId: running.turnId, ...session.contextWindow,
    } });
  }

  async listMcpServers(threadId: string): Promise<CodexMcpServerSummary[]> {
    const query = this.running.get(threadId)?.query;
    if (!query) throw new Error("Claude MCP inventory is available while a turn is running.");
    const servers = await query.mcpServerStatus();
    return servers.map((server) => ({
      name: server.name,
      authStatus: server.status === "needs-auth" ? "notLoggedIn" as const : "unsupported" as const,
      startupStatus: server.status === "connected" ? "ready" as const : server.status === "pending" ? "starting" as const : "failed" as const,
      startupError: server.error,
      tools: server.tools?.map((tool) => tool.name) ?? [],
    }));
  }

  private async consumeCompleteMessage(message: SDKMessage, threadId: string, running: RunningTurn): Promise<void> {
    const turnId = running.turnId;
    if (message.type === "assistant" && !message.parent_tool_use_id) {
      const text = message.message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
      if (text) {
        const entry: AppServerThreadMessageEntry = { type: "message", id: message.message.id, role: "assistant", text, turn: { id: turnId } };
        running.entries.set(entry.id, entry);
        await this.store.append(threadId, [entry]);
        await this.emit({ method: "item/completed", params: { threadId, turnId, item: { id: entry.id, type: "agentMessage", text } } });
      }
      for (const block of message.message.content) {
        if (block.type !== "tool_use") continue;
        const input = block.input as Record<string, unknown>;
        running.entries.set(block.id, {
          type: "activity", id: block.id, summary: block.name, status: "in_progress", turn: { id: turnId },
          details: [{ id: block.id, kind: block.name === "Bash" ? "command" : "read", label: block.name, markdown: JSON.stringify(input) }],
        });
        await this.store.append(threadId, [running.entries.get(block.id)!]);
        await this.emit({ method: "item/started", params: { threadId, turnId, item: {
          id: block.id, type: "dynamicToolCall", toolName: block.name, arguments: input,
        } } });
      }
    }
    if (message.type === "user" && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type !== "tool_result") continue;
        const entry = running.entries.get(block.tool_use_id);
        if (entry?.type !== "activity") continue;
        entry.status = block.is_error ? "failed" : "completed";
        entry.details[0].markdown = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        await this.store.append(threadId, [entry]);
        await this.emit({ method: "item/completed", params: { threadId, turnId, item: {
          id: entry.id, type: "dynamicToolCall", toolName: entry.summary, status: entry.status,
          contentItems: [{ type: "inputText", text: entry.details[0].markdown ?? "" }],
        } } });
      }
    }
  }

  async interruptTurn(params: { threadId: string; turnId: string }): Promise<typeof params> {
    const running = this.running.get(params.threadId);
    if (running && running.turnId !== params.turnId) throw new Error("The active Claude turn has changed.");
    running?.controller.abort();
    running?.query?.close();
    await running?.done;
    return params;
  }

  async close(): Promise<void> {
    await Promise.all([...this.running.entries()].map(([threadId, running]) => this.interruptTurn({ threadId, turnId: running.turnId })));
  }
}

function claudeUserMessageParts(input: AppServerTurnInputItem[]): AppServerThreadMessagePart[] {
  return input.flatMap((item): AppServerThreadMessagePart[] => {
    if (item.type === "text") return [{ type: "text", text: item.text }];
    if (item.type === "image") return [{ type: "image", url: item.url, alt: item.name }];
    if (item.type === "localImage") return [{
      type: "image",
      url: toTranscriptImageProtocolUrl(pathToFileURL(item.path).toString()),
      alt: item.name ?? path.basename(item.path),
    }];
    if (item.type === "localFile") return [{
      type: "file", name: item.name ?? path.basename(item.path),
      mimeType: item.mimeType, sizeBytes: item.sizeBytes,
    }];
    return [];
  });
}

async function claudeInput(input: AppServerTurnInputItem[]): Promise<SDKUserMessage["message"]["content"]> {
  const content: Exclude<SDKUserMessage["message"]["content"], string> = [];
  for (const item of input) {
    if (item.type === "text") content.push({ type: "text", text: item.text });
    else if (item.type === "localFile") content.push({ type: "text", text: `Attached file: ${item.path}${item.textPreview ? `\n${item.textPreview}` : ""}` });
    else if (item.type === "image" || item.type === "localImage") {
      const url = item.type === "image" ? item.url : `data:image/${/\.jpe?g$/i.test(item.path) ? "jpeg" : /\.webp$/i.test(item.path) ? "webp" : "png"};base64,${(await readFile(item.path)).toString("base64")}`;
      const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(url);
      if (!match) throw new Error("Claude image input must be a PNG, JPEG, GIF, or WebP attachment.");
      content.push({ type: "image", source: { type: "base64", media_type: match[1] as "image/png", data: match[2] } });
    } else {
      throw new Error(`Claude does not support ${item.type} input.`);
    }
  }
  return content;
}
