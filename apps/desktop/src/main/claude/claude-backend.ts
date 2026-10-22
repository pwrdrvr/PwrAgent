import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getSessionInfo, query, type AccountInfo, type Options, type Query, type SDKMessage, type SDKUserMessage, type SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentEvent, AppServerAvailableCommandSummary, AppServerPendingRequestNotification, AppServerThreadEntry,
  AppServerThreadMessageEntry, AppServerThreadMessagePart, AppServerThreadReplay, AppServerThreadSummary,
  AppServerTurnInputItem, BackendModelOption, BackendRateLimitSummary, BackendSummary, ThreadExecutionMode, CodexMcpServerSummary,
} from "@pwragent/shared";
import { getMainLogger } from "../log";
import { resolveActiveProfilePath } from "../profile";
import { toTranscriptImageProtocolUrl } from "../transcript-image-protocol";
import { CLAUDE_SETUP_INSTRUCTIONS, claudeEnvironment, inspectClaudeInstallation, type ClaudeInstallation } from "./claude-executable";
import { createClaudePermissionHandler, claudePermissionMode } from "./claude-permissions";
import { claudeHarnessOptions, discoverClaudeModels, readClaudeMetadata } from "./claude-models";
import { CLAUDE_TERMINAL_COMMANDS_SEED, claudeCommandSummaries } from "./claude-commands";
import {
  claudeRateLimits, claudeStreamRateLimits, claudeTelemetry, claudeTurnUsage, liveClaudeRateLimits,
  mergeClaudeStreamRateLimits, nextClaudeRateLimitReset,
} from "./claude-usage";
import { claudeCommandActivity, groupClaudeActivities } from "./claude-activity";
import { ClaudeSessionStore, type ClaudeSession } from "./claude-session-store";
import { normalizeClaudeTitle, requestClaudeTitle, type ClaudeTitleQuery } from "./claude-titles";

export type ClaudeBackendOptions = {
  store?: ClaudeSessionStore;
  query?: typeof query;
  getSessionInfo?: typeof getSessionInfo;
  inspectInstallation?: typeof inspectClaudeInstallation;
  discoverModels?: typeof discoverClaudeModels;
  readCommands?: (params: { executable: string; env: NodeJS.ProcessEnv; cwd: string }) => Promise<SlashCommand[]>;
  resolveEnv?: () => Promise<NodeJS.ProcessEnv>;
  emit: (event: AgentEvent) => Promise<void>;
  request: (request: AppServerPendingRequestNotification, signal: AbortSignal) => Promise<unknown>;
  cancelRequest: (threadId: string, turnId: string, requestId: string) => Promise<void>;
};

const claudeBackendLog = getMainLogger("pwragent:claude-backend");

/** setTimeout's longest delay; a later reset re-arms on wake. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Signed out, or billed outside a Claude subscription: no plan limit applies. */
function claudeHasNoPlanLimits({ authStatus, authMethod }: ClaudeInstallation): boolean {
  return authStatus === "sign-in-required" || authMethod === "api-key" || authMethod === "external";
}

/** Tells accounts apart without keeping their identifiers. */
function claudeAccountKey(info: AccountInfo): string {
  return createHash("sha256")
    .update(JSON.stringify([info.apiProvider ?? "", info.organization ?? "", info.email ?? ""]))
    .digest("hex").slice(0, 16);
}

type RunningTurn = {
  turnId: string;
  controller: AbortController;
  query?: Query;
  done?: Promise<void>;
  entries: Map<string, AppServerThreadEntry>;
  started?: boolean;
  contextWindow?: ClaudeSession["contextWindow"];
  input: ClaudeInputStream;
  pendingSteers: Set<string>;
  /** The SDK emits one assistant message per content block, sharing an id. */
  completedMessageText: Map<string, string>;
  inputWrites: Promise<void>;
  ending?: boolean;
  /** One background context probe at a time; a request while it runs reruns it once. */
  contextRefresh?: { promise: Promise<void>; again: boolean };
  titlePrompt?: string;
  titleEnv?: NodeJS.ProcessEnv;
};

/** One input pump owns the SDK's stdin until the logical turn finishes. */
class ClaudeInputStream {
  private readonly messages: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) throw new Error("Claude input is closed.");
    this.messages.push(message);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      const message = this.messages.shift();
      if (message) yield message;
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}

export class ClaudeBackend {
  private readonly store: ClaudeSessionStore;
  private readonly running = new Map<string, RunningTurn>();
  private installation: ClaudeInstallation = { authStatus: "unknown", message: CLAUDE_SETUP_INSTRUCTIONS };
  private discovery?: { models: boolean; promise: Promise<void> };
  private modelDiscovery?: Promise<void>;
  private nextModelRefreshAt = 0;
  private models?: BackendModelOption[];
  // Account-wide, so one thread's turn must never clear another's view.
  private rateLimits: BackendSummary["rateLimits"];
  private rateLimitsLoad?: Promise<void>;
  private rateLimitWrites = Promise.resolve();
  /** The account the limits describe, as `claudeAccountKey`. */
  private rateLimitAccount?: string;
  private rateLimitExpiry?: ReturnType<typeof setTimeout>;
  // Last command list Claude reported per working directory. Project
  // commands and skills differ by folder, so the folder is the key.
  private readonly commandsByCwd = new Map<string, AppServerAvailableCommandSummary[]>();
  private readonly commandProbes = new Map<string, Promise<AppServerAvailableCommandSummary[]>>();
  private readonly commandProbeRetryAt = new Map<string, number>();
  private terminalCommands = new Set(CLAUDE_TERMINAL_COMMANDS_SEED);

  constructor(private readonly options: ClaudeBackendOptions) {
    this.store = options.store ?? new ClaudeSessionStore(path.join(resolveActiveProfilePath("state"), "claude"));
  }

  async discover(options: { models?: boolean } = {}): Promise<void> {
    const models = options.models !== false;
    const inFlight = this.discovery;
    // An installation-only check cannot answer a request for the model catalog.
    if (inFlight && (inFlight.models || !models)) return await inFlight.promise;
    if (inFlight) await inFlight.promise.catch(() => {});
    const discovery = {
      models,
      promise: (async () => {
        const env = claudeEnvironment(await this.options.resolveEnv?.() ?? process.env);
        this.installation = await (this.options.inspectInstallation ?? inspectClaudeInstallation)({ env });
        if (models && this.installation.executable && this.installation.authStatus !== "sign-in-required") {
          await this.refreshModelCatalog(env);
        }
        if (claudeHasNoPlanLimits(this.installation)) {
          this.setRateLimits([]);
        } else {
          await this.loadRateLimits();
        }
      })(),
    };
    this.discovery = discovery;
    try { await discovery.promise; } finally { if (this.discovery === discovery) this.discovery = undefined; }
  }

  summary(): BackendSummary {
    const available = Boolean(this.installation.executable) && this.installation.authStatus !== "sign-in-required";
    return {
      kind: "claude", source: "builtin", label: "Claude", available,
      claude: { ...this.installation },
      // Remembered limits describe a usable install; hide them while Claude is unavailable.
      rateLimits: this.rateLimits && (available ? liveClaudeRateLimits(this.rateLimits, Date.now()) : []),
      unavailableReason: available ? undefined : this.installation.message,
      methods: [],
      capabilities: {
        listThreads: true, createThread: true, resumeThread: true, renameThread: true,
        readThread: true, startTurn: true, interruptTurn: true, steerTurn: true,
        archiveThread: true, restoreThread: true, archiveWorktree: false,
        transcriptPagination: false, toolUse: true, approvalRequests: true,
        multiDirectoryThreads: false,
      },
      executionModes: [
        { mode: "default", label: "Default", available: true, isDefault: true },
        { mode: "auto", label: "Auto", available: true },
        { mode: "full-access", label: "Full Access", available: true },
      ],
      // Stable aliases remain usable until global discovery reports models.
      launchpadOptions: { models: this.models ?? [
        { id: "sonnet", label: "Sonnet", supportsImage: true },
        { id: "opus", label: "Opus", supportsImage: true },
        { id: "haiku", label: "Haiku", supportsImage: true },
      ] },
    };
  }

  private async requireInstallation(): Promise<string> {
    // Inspection spawns the CLI three times. Reuse a usable result; an explicit
    // Settings check or startup refresh re-inspects through discover().
    if (this.installation.executable && this.installation.authStatus !== "sign-in-required") {
      return this.installation.executable;
    }
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
    const ordered = groupClaudeActivities([...entries.values()]);
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
    const running: RunningTurn = {
      turnId: randomUUID(), controller: new AbortController(), entries: new Map(),
      input: new ClaudeInputStream(), pendingSteers: new Set(), completedMessageText: new Map(),
      inputWrites: Promise.resolve(),
    };
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
      running.titlePrompt = firstPrompt?.type === "text" ? firstPrompt.text : undefined;
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
      running.titleEnv = env;
      const permissionMode = claudePermissionMode(params.executionMode ?? session.thread.executionMode ?? "default");
      const sdkOptions: Options = {
        ...claudeHarnessOptions(executable, env),
        cwd: session.cwd,
        ...(session.sdkSessionId ? { resume: session.sdkSessionId } : { sessionId: params.threadId }),
        systemPrompt: { type: "preset", preset: "claude_code", ...(params.instructions ? { append: params.instructions } : {}) },
        persistSession: true,
        ...(session.thread.titleSource === "explicit" ? { title: session.thread.title } : {}),
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
        yield* running.input;
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
      running.ending = true;
      running.input.close();
      // A steer accepted during startup writes its own row; let it land
      // before the failed status, so the failed status is final.
      await this.settleInputWrites(running);
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

  private async publishModels(models: BackendModelOption[]): Promise<void> {
    if (models.length === 0) return;
    const changed = JSON.stringify(this.models) !== JSON.stringify(models);
    this.models = models;
    if (changed) await this.emit({ method: "backend/providerStatus/updated", params: { backend: "claude" } });
  }

  private refreshModelCatalog(env: NodeJS.ProcessEnv): Promise<void> {
    if (this.modelDiscovery) return this.modelDiscovery;
    const { executable, version } = this.installation;
    if (!executable) return Promise.resolve();
    this.modelDiscovery = (async () => {
      const models = await (this.options.discoverModels ?? discoverClaudeModels)({
        executable, env, ...(version ? { cliVersion: version } : {}),
      });
      this.nextModelRefreshAt = Date.now() + 60_000;
      await this.publishModels(models);
    })().finally(() => { this.modelDiscovery = undefined; });
    return this.modelDiscovery;
  }

  private async refreshGlobalModels(): Promise<void> {
    if (Date.now() < this.nextModelRefreshAt) return;
    // A new turn can recover missing/stale metadata, but never spawns more
    // than one global probe per minute or waits for it to consume the stream.
    this.nextModelRefreshAt = Date.now() + 60_000;
    const env = claudeEnvironment(await this.options.resolveEnv?.() ?? process.env);
    await this.refreshModelCatalog(env);
  }

  private async consume(session: ClaudeSession, running: RunningTurn): Promise<void> {
    const threadId = session.thread.id;
    const turnId = running.turnId;
    let messageId = "";
    let failure: string | undefined;
    let receivedResult = false;
    const needsUsageBaseline = Boolean(session.sdkSessionId) && !session.modelUsage;
    const usageBaseline = session.modelUsage;
    try {
      for await (const message of running.query!) {
        if (message.type === "system" && message.subtype === "init") {
          // Never publish this query's project-scoped supportedModels() to
          // the backend-wide picker. Recover through separate global discovery.
          void this.refreshGlobalModels().catch(() => {});
          session.sdkSessionId = message.session_id;
          const current = await this.store.read(threadId);
          current.sdkSessionId = message.session_id;
          await this.store.save(current);
          if (message.terminal_slash_commands) this.terminalCommands = new Set(message.terminal_slash_commands);
          await Promise.all([
            // A probe that finds no windows keeps the last reading, so the
            // account must be confirmed first.
            this.checkAccount(running).then(() => this.refreshUsage(running)),
            this.refreshContext(session, running),
            claudeTelemetry(() => running.query!.supportedCommands())
              .then((commands) => commands && this.publishCommands(session, commands)),
          ]);
        }
        if (message.type === "system" && message.subtype === "commands_changed") {
          await this.publishCommands(session, message.commands);
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
          const update = claudeStreamRateLimits(message.rate_limit_info);
          if (this.setRateLimits(mergeClaudeStreamRateLimits(this.rateLimits ?? [], update, Date.now()))) {
            await this.emit({ method: "backend/providerStatus/updated", params: { backend: "claude" } });
          }
        }
        await this.consumeCompleteMessage(message, threadId, running);
        // The probe is a control round-trip that can wait 1.5s; never hold
        // the stream for it. The result boundary below reads it in order.
        if (message.type === "assistant" && !message.parent_tool_use_id) {
          this.scheduleContextRefresh(session, running);
        }
        if (message.type === "result") {
          // A message arriving near a result boundary may become another native
          // turn. Keep this query alive until its result acknowledges every
          // accepted steer UUID; the first result alone must not discard input.
          await this.settleInputWrites(running);
          for (const id of message.user_message_uuids ?? []) running.pendingSteers.delete(id);
          if (message.user_message_uuid) running.pendingSteers.delete(message.user_message_uuid);
          const finished = message.is_error || running.pendingSteers.size === 0;
          if (finished) running.ending = true;
          receivedResult = true;
          const requestedTitle = finished && !message.is_error && !running.controller.signal.aborted
            ? await this.updateTitle(session, running) : false;
          await running.contextRefresh?.promise;
          const [, usage] = await Promise.all([this.refreshContext(session, running), this.refreshUsage(running)]);
          // Native title generation shares this session's account and model
          // totals. Its request can land after the result's usage snapshot.
          const modelUsage = requestedTitle ? usage?.session?.model_usage ?? message.modelUsage : message.modelUsage;
          const hasUsage = modelUsage && Object.values(modelUsage).some((value) =>
            value.inputTokens + value.outputTokens + value.cacheReadInputTokens + value.cacheCreationInputTokens > 0);
          if (hasUsage) {
            const canAttribute = !needsUsageBaseline;
            const tokenUsage = claudeTurnUsage(modelUsage, usageBaseline);
            session.modelUsage = modelUsage;
            // Without an old session's baseline, cumulative spend cannot be
            // attributed to this turn. Save it for the next turn, do not bill
            // the pre-existing transcript as new work.
            if (canAttribute && finished) {
              await this.emit({ method: "thread/tokenUsage/updated", params: { threadId, turnId, model: tokenUsage.model, tokenUsage } });
            }
          }
          if (message.is_error) failure = message.subtype === "success" ? message.result : message.errors.join("\n");
          if (finished) break;
        }
      }
      if ((!receivedResult || running.pendingSteers.size > 0) && !running.controller.signal.aborted) failure = "Claude exited before completing the turn.";
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      running.ending = true;
      running.input.close();
      await this.settleInputWrites(running);
      await running.contextRefresh?.promise;
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

  /** Prefer a durable provider title; SDK headless sessions otherwise need an explicit control request. */
  private async updateTitle(session: ClaudeSession, running: RunningTurn): Promise<boolean> {
    const threadId = session.thread.id;
    try {
      let current = await this.store.read(threadId);
      if (current.thread.titleSource === "explicit" || !session.sdkSessionId) return false;
      // getSessionInfo uses the SDK host's config directory, not Options.env.
      // Do not inspect a different account's session store.
      if (running.titleEnv?.CLAUDE_CONFIG_DIR !== process.env.CLAUDE_CONFIG_DIR) return false;
      // The SDK may spawn Git in this workspace (with its own timeout).
      // Unlike query telemetry, this read cannot be cancelled by closing the
      // query. Keep it owned by the turn so shutdown cannot release the
      // workspace while an abandoned read still holds its directory open.
      const info = await (this.options.getSessionInfo ?? getSessionInfo)(session.sdkSessionId, { dir: session.cwd });
      let title = normalizeClaudeTitle(info?.customTitle);
      current = await this.store.read(threadId);
      if (current.thread.titleSource === "explicit") return false;
      const query = running.query as ClaudeTitleQuery;
      const disabled = ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_DISABLE_TERMINAL_TITLE"]
        .some((key) => ["1", "true", "yes", "on"].includes(running.titleEnv?.[key]?.trim().toLowerCase() ?? ""));
      const canRequest = !title && !current.titleGenerationAttempted && !disabled && typeof query.generateSessionTitle === "function"
        && Boolean(running.titlePrompt?.trim()) && !running.controller.signal.aborted;
      if (!title && !canRequest) return false;
      // Persist the attempt before spending quota so failure/restart cannot
      // create a title request on every turn.
      if (!current.titleGenerationAttempted) {
        current.titleGenerationAttempted = true;
        await this.store.save(current);
      }
      if (canRequest) title = await requestClaudeTitle(query, running.titlePrompt!, running.controller.signal);
      if (title && !running.controller.signal.aborted) {
        current = await this.store.read(threadId);
        if (current.thread.titleSource !== "explicit" && current.thread.title !== title) {
          current.thread.title = title;
          current.thread.titleSource = "derived";
          await this.store.save(current);
          await this.emit({ method: "thread/name/updated", params: { threadId, threadName: title, titleSource: "derived" } });
        }
      }
      return canRequest;
    } catch {
      // An unreadable provider session must not trigger a speculative title
      // request or fail the actual turn. The local prompt name remains usable.
      return false;
    }
  }

  private async refreshUsage(running: RunningTurn) {
    const usage = await claudeTelemetry(() => running.query!.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }));
    // The snapshot is complete, so it replaces every window. A probe that
    // timed out or returned nothing keeps the last good reading. Only an
    // account Claude does not meter by subscription clears it.
    const limits = usage?.rate_limits_available && usage.rate_limits ? claudeRateLimits(usage) : [];
    if (limits.length > 0) this.setRateLimits(limits);
    else if (usage && !usage.rate_limits_available && claudeHasNoPlanLimits(this.installation)) {
      this.setRateLimits([]);
    }
    // Emitted after every probe, changed or not: it marks the turn's provider
    // refresh as settled for listeners.
    await this.emit({ method: "backend/providerStatus/updated", params: { backend: "claude" } });
    return usage;
  }

  /**
   * Installation checks are cached for the session, so a sign-in to another
   * account shows up here first. Limits from a different account are cleared.
   */
  private async checkAccount(running: RunningTurn): Promise<void> {
    const info = await claudeTelemetry(() => running.query!.accountInfo());
    if (!info) return;
    const account = claudeAccountKey(info);
    await this.loadRateLimits();
    if (account === this.rateLimitAccount) return;
    const previous = this.rateLimitAccount;
    this.rateLimitAccount = account;
    // A file from before accounts were recorded is adopted, not discarded.
    if (previous !== undefined) this.setRateLimits([]);
    else this.saveRateLimits();
  }

  private async loadRateLimits(): Promise<void> {
    this.rateLimitsLoad ??= this.store.readRateLimits().then(({ limits, account }) => {
      // A reading taken since launch is newer than the file.
      if (this.rateLimits !== undefined) return;
      this.rateLimits = liveClaudeRateLimits(limits, Date.now());
      this.rateLimitAccount ??= account;
      this.scheduleRateLimitExpiry();
    });
    await this.rateLimitsLoad;
  }

  /** Returns whether the reading changed; a change is also written for the next launch. */
  private setRateLimits(limits: BackendRateLimitSummary[]): boolean {
    if (this.rateLimits && JSON.stringify(limits) === JSON.stringify(this.rateLimits)) return false;
    this.rateLimits = limits;
    this.saveRateLimits();
    this.scheduleRateLimitExpiry();
    return true;
  }

  private saveRateLimits(): void {
    const limits = this.rateLimits ?? [];
    const account = this.rateLimitAccount;
    this.rateLimitWrites = this.rateLimitWrites
      .then(() => this.store.saveRateLimits(limits, account))
      .catch((error: unknown) => {
        claudeBackendLog.warn("Could not save Claude usage limits", error);
      });
  }

  /**
   * summary() hides a window once it resets. Tell listeners when that
   * happens, so a surface that refreshes only on events drops the row.
   */
  private scheduleRateLimitExpiry(): void {
    if (this.rateLimitExpiry) clearTimeout(this.rateLimitExpiry);
    this.rateLimitExpiry = undefined;
    const next = nextClaudeRateLimitReset(this.rateLimits ?? [], Date.now());
    if (next === undefined) return;
    this.rateLimitExpiry = setTimeout(() => {
      this.rateLimitExpiry = undefined;
      this.scheduleRateLimitExpiry();
      if (next > Date.now()) return;
      this.emit({ method: "backend/providerStatus/updated", params: { backend: "claude" } }).catch((error: unknown) => {
        claudeBackendLog.warn("Could not report an expired Claude usage limit", error);
      });
    }, Math.min(next - Date.now() + 1, MAX_TIMER_DELAY_MS));
    this.rateLimitExpiry.unref?.();
  }

  private scheduleContextRefresh(session: ClaudeSession, running: RunningTurn): void {
    if (running.contextRefresh) {
      running.contextRefresh.again = true;
      return;
    }
    const refresh = { again: false, promise: Promise.resolve() };
    refresh.promise = (async () => {
      try {
        do {
          refresh.again = false;
          await this.refreshContext(session, running);
        } while (refresh.again && !running.ending);
      } catch {
        // A meter update must never fail the turn.
      } finally {
        running.contextRefresh = undefined;
      }
    })();
    running.contextRefresh = refresh;
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

  private async publishCommands(session: ClaudeSession, commands: readonly SlashCommand[]): Promise<void> {
    const summaries = claudeCommandSummaries(commands, this.terminalCommands);
    if (summaries.length === 0) return;
    this.commandsByCwd.set(session.cwd, summaries);
    await this.emit({ method: "thread/availableCommands/updated", params: { threadId: session.thread.id, commands: summaries } });
  }

  /**
   * Slash commands for a thread or a launchpad folder. A folder Claude has not
   * reported for yet is asked once, through a session that receives no prompt.
   * A failed probe waits a minute before the next try, so a `/` typed while the
   * CLI is broken cannot spawn a process per keystroke.
   */
  async listCommands(params: { threadId?: string; cwd?: string }): Promise<AppServerAvailableCommandSummary[]> {
    const cwd = (params.threadId ? await this.store.read(params.threadId).then((session) => session.cwd, () => undefined) : undefined)
      ?? params.cwd;
    if (!cwd) return [];
    const known = this.commandsByCwd.get(cwd);
    if (known) return known;
    const inFlight = this.commandProbes.get(cwd);
    if (inFlight) return await inFlight;
    if (Date.now() < (this.commandProbeRetryAt.get(cwd) ?? 0)) return [];
    const probe = (async () => {
      try {
        const executable = await this.requireInstallation();
        const env = claudeEnvironment(await this.options.resolveEnv?.() ?? process.env);
        const commands = await (this.options.readCommands ?? ((probeParams) => readClaudeMetadata({
          ...probeParams,
          read: (session) => session.supportedCommands(),
          timeoutMessage: "Claude command discovery timed out.",
        })))({ executable, env, cwd });
        const summaries = claudeCommandSummaries(commands, this.terminalCommands);
        // A live turn may have reported while the probe ran; it is fresher.
        if (summaries.length > 0 && !this.commandsByCwd.has(cwd)) this.commandsByCwd.set(cwd, summaries);
        if (summaries.length === 0) this.commandProbeRetryAt.set(cwd, Date.now() + 60_000);
        return this.commandsByCwd.get(cwd) ?? summaries;
      } catch {
        this.commandProbeRetryAt.set(cwd, Date.now() + 60_000);
        return [];
      } finally {
        this.commandProbes.delete(cwd);
      }
    })();
    this.commandProbes.set(cwd, probe);
    return await probe;
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
    if (message.type === "system" && message.subtype === "local_command_output") {
      const entry: AppServerThreadMessageEntry = {
        type: "message", id: message.uuid, role: "assistant", text: message.content, turn: { id: turnId },
      };
      running.entries.set(entry.id, entry);
      await this.store.append(threadId, [entry]);
      await this.emit({ method: "item/completed", params: {
        threadId, turnId, item: { id: entry.id, type: "agentMessage", text: entry.text },
      } });
    }
    if (message.type === "assistant" && !message.parent_tool_use_id) {
      const text = message.message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
      if (text) {
        // A later text block of the same message must extend, not replace,
        // the text an earlier block completed.
        // Streamed deltas already include the current block. Only completed
        // blocks may contribute to the prefix when its final frame arrives.
        const completed = running.completedMessageText.get(message.message.id);
        const prior = completed ? `${completed}\n` : "";
        running.completedMessageText.set(message.message.id, prior + text);
        const entry: AppServerThreadMessageEntry = { type: "message", id: message.message.id, role: "assistant", text: prior + text, turn: { id: turnId } };
        running.entries.set(entry.id, entry);
        await this.store.append(threadId, [entry]);
        await this.emit({ method: "item/completed", params: { threadId, turnId, item: { id: entry.id, type: "agentMessage", text: entry.text } } });
      }
      for (const block of message.message.content) {
        if (block.type !== "tool_use") continue;
        const input = block.input as Record<string, unknown>;
        const command = block.name === "Bash" && typeof input.command === "string" ? input.command : undefined;
        running.entries.set(block.id, {
          ...(command !== undefined
            ? claudeCommandActivity({ id: block.id, command, status: "in_progress" })
            : {
              type: "activity" as const, id: block.id, summary: block.name, status: "in_progress" as const,
              details: [{ id: block.id, kind: "read" as const, label: block.name, markdown: JSON.stringify(input) }],
            }),
          createdAt: Date.now(), turn: { id: turnId },
        });
        await this.store.append(threadId, [running.entries.get(block.id)!]);
        const item = {
          id: block.id, status: "in_progress",
          ...(command !== undefined ? { type: "commandExecution", command }
            : { type: "dynamicToolCall", toolName: block.name, arguments: input }),
        };
        await this.emit({ method: "item/started", params: { threadId, turnId, item } });
      }
    }
    if (message.type === "user" && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type !== "tool_result") continue;
        const entry = running.entries.get(block.tool_use_id);
        if (entry?.type !== "activity") continue;
        entry.status = block.is_error ? "failed" : "completed";
        const output = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        const command = entry.details[0].command?.rawCommand;
        if (command !== undefined) {
          entry.details = claudeCommandActivity({ id: entry.id, command, status: entry.status, output }).details;
        } else {
          // Keep the invocation when updating generic tools, too.
          const outputId = `${entry.id}:output`;
          entry.details = [...entry.details.filter((detail) => detail.id !== outputId), {
            id: outputId, kind: entry.details[0].kind, label: `${entry.summary} output`, markdown: output, status: entry.status,
          }];
        }
        await this.store.append(threadId, [entry]);
        const item = {
          id: entry.id, status: entry.status,
          ...(command !== undefined ? { type: "commandExecution", command, aggregatedOutput: output }
            : { type: "dynamicToolCall", toolName: entry.summary,
              contentItems: [{ type: "inputText", text: output }] }),
        };
        await this.emit({ method: "item/completed", params: { threadId, turnId, item } });
      }
    }
  }

  async interruptTurn(params: { threadId: string; turnId: string }): Promise<typeof params> {
    const running = this.running.get(params.threadId);
    if (running && running.turnId !== params.turnId) throw new Error("The active Claude turn has changed.");
    if (running) running.ending = true;
    running?.input.close();
    running?.controller.abort();
    running?.query?.close();
    await running?.done;
    return params;
  }

  async steerTurn(params: { threadId: string; expectedTurnId: string; input: AppServerTurnInputItem[] }): Promise<{
    threadId: string; turnId: string; messageId: string;
  }> {
    const running = this.running.get(params.threadId);
    if (!running) throw new Error("Claude has no active turn. Queue the message instead.");
    const assertActive = () => {
      if (this.running.get(params.threadId) !== running || running.ending || running.controller.signal.aborted) {
        throw new Error("Claude has no active turn. Queue the message instead.");
      }
      if (running.turnId !== params.expectedTurnId) throw new Error("Claude expected active turn id has changed.");
      // Before the query launches, the input stream buffers the steer; the
      // prompt generator sends it right after the first prompt.
    };
    assertActive();
    const content = await claudeInput(params.input);
    const uuid = randomUUID();
    const messageId = `user:${uuid}`;
    const operation = running.inputWrites.then(async () => {
      assertActive();
      // Native result receipts retain at most 64 consumed UUIDs, including
      // the original prompt. Never accept more than we can acknowledge.
      if (running.pendingSteers.size >= 63) throw new Error("Claude has too many pending steer messages. Queue this message instead.");
      const parts = claudeUserMessageParts(params.input);
      const entry: AppServerThreadMessageEntry = {
        type: "message", id: messageId, role: "user", parts,
        text: parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n"),
        createdAt: Date.now(), turn: { id: running.turnId, status: "in_progress" },
      };
      // Hand the message to Claude before any await: the turn can end while
      // history is written, and a rejected steer must leave no transcript row.
      running.entries.set(messageId, entry);
      running.pendingSteers.add(uuid);
      running.input.push({ type: "user", uuid, priority: "now", parent_tool_use_id: null,
        message: { role: "user", content } });
      // The message is already sent; turn completion persists every entry,
      // so an early-write failure must not report the steer as rejected.
      await this.store.append(params.threadId, [entry]).catch(() => {});
      await this.emit({ method: "item/completed", params: {
        threadId: params.threadId, turnId: running.turnId,
        item: { id: messageId, type: "userMessage", text: entry.text, content: parts },
      } });
    });
    running.inputWrites = operation.catch(() => {});
    await operation;
    return { threadId: params.threadId, turnId: running.turnId, messageId };
  }

  private async settleInputWrites(running: RunningTurn): Promise<void> {
    let writes: Promise<void>;
    do {
      writes = running.inputWrites;
      await writes;
    } while (writes !== running.inputWrites);
  }

  async close(): Promise<void> {
    if (this.rateLimitExpiry) clearTimeout(this.rateLimitExpiry);
    this.rateLimitExpiry = undefined;
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

const LOCAL_IMAGE_TYPES: Record<string, string> = {
  ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".gif": "gif", ".webp": "webp",
};

async function claudeInput(input: AppServerTurnInputItem[]): Promise<SDKUserMessage["message"]["content"]> {
  const content: Exclude<SDKUserMessage["message"]["content"], string> = [];
  for (const item of input) {
    if (item.type === "text") content.push({ type: "text", text: item.text });
    else if (item.type === "localFile") content.push({ type: "text", text: `Attached file: ${item.path}${item.textPreview ? `\n${item.textPreview}` : ""}` });
    else if (item.type === "image" || item.type === "localImage") {
      // The API rejects a media type that does not match the bytes, so an
      // unknown extension must fail here rather than be labelled PNG.
      const localType = item.type === "localImage" ? LOCAL_IMAGE_TYPES[path.extname(item.path).toLowerCase()] : undefined;
      if (item.type === "localImage" && !localType) throw new Error("Claude image input must be a PNG, JPEG, GIF, or WebP attachment.");
      const url = item.type === "image" ? item.url : `data:image/${localType};base64,${(await readFile(item.path)).toString("base64")}`;
      const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(url);
      if (!match) throw new Error("Claude image input must be a PNG, JPEG, GIF, or WebP attachment.");
      content.push({ type: "image", source: { type: "base64", media_type: match[1] as "image/png", data: match[2] } });
    } else {
      throw new Error(`Claude does not support ${item.type} input.`);
    }
  }
  return content;
}
