import { randomUUID } from "node:crypto";
import {
  DEFAULT_FORGE_AGENT_TOOL_POLICY,
  FORGE_AGENT_RULE_APPROVAL_SOURCE,
  FORGE_AGENT_TOOL_GROUP_LABELS,
  FORGE_APPROVAL_MERGE_METHODS_META_KEY,
  FORGE_APPROVAL_MERGE_QUEUE_META_KEY,
  FORGE_APPROVAL_REMEMBER_OPTIONS_META_KEY,
  buildForgeApprovalRememberOptions,
  forgeAgentRuleAgentKey,
  forgeAgentToolRuleDescription,
  forgeAgentToolRuleOffMessage,
  forgeAgentToolRuleSentence,
  forgeAgentToolUnreadableRuleSentence,
  forgeApprovalRememberRuleAgent,
  forgeRuleRepositoryLabel,
  isAcpBackendId,
  isAppServerBackendKind,
  isForgeApprovalRememberGroup,
  normalizeForgeRuleRepository,
  normalizePullRequestProvider,
  parseCodexProviderModelId,
  readForgeApprovalMergeMethodChoice,
  readForgeApprovalRememberChoice,
  resolveForgeAgentToolAccess,
  type AgentEvent,
  type AppServerBackendKind,
  type AppServerCollaborationModeRequest,
  type AppServerPendingRequestNotification,
  type AttachThreadPullRequestToolArgs,
  type CodexModelProviderSettings,
  type DetachThreadPullRequestRequest,
  type DetachThreadPullRequestResponse,
  type ForgeAgentIdentity,
  type ForgeAgentRuleNames,
  type ForgeAgentToolAccess,
  type ForgeAgentToolGroup,
  type ForgeAgentToolPolicy,
  type ForgeAgentToolRuleGroup,
  type ForgeApprovalMergeMethods,
  type ForgeApprovalMergeQueue,
  type ForgeApprovalRememberOptionId,
  type NavigationSnapshot,
  type PrSummary,
  type PwrAgentThreadInspectionResponse,
  type RefreshOwnedThreadPullRequestsRequest,
  type RefreshThreadPullRequestsResponse,
  type ThreadExecutionMode,
  type ThreadInspectionSummary,
  type ThreadOverlayState,
  type ThreadTodoMergeMethod,
} from "@pwragent/shared";
import type { AgentToolCallContext } from "../agent-tools/agent-tool-definition";
import type { ForgeReadHandler } from "../agent-tools/pwragent-forge-agent-tools";
import {
  buildForgeToolDefinitions,
  type ForgePrToolHandler,
  type ForgePrToolPreflight,
  type ForgePrToolPreflightResult,
} from "../agent-tools/pwragent-forge-pr-agent-tools";
import type { PwrAgentThreadTodoHandler } from "../agent-tools/pwragent-thread-todo-agent-tools";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { claudePlanTurnRefusal } from "../claude/claude-permissions";
import { getMainLogger } from "../log";
import {
  forgePrToolGroup,
  type ForgePrToolArgs,
  type ForgePrToolOperation,
} from "../pr-status/forge-pr-tool-contract";
import {
  buildPullRequestReferenceUrl,
  parsePullRequestReferenceUrl,
  type PullRequestReferenceIdentity,
  type PullRequestRepositoryRef,
} from "../pr-status/forge-reference";
import {
  ForgeReadError,
  repositoryKey,
  validateForgeReadArgs,
  type ForgeReadRequest,
  type ForgeRepository,
} from "../pr-status/forge-tool-contract";
import type { RegistryHandlers } from "./backend-registry-handlers";
import { readRecord } from "./backend-registry-notification-values";
import {
  forgeToolApprovalMessage,
  forgeToolParamsDisplay,
  withForgeApprovalNotes,
} from "./backend-registry-notifications";
import {
  FORGE_APPROVAL_WITHDRAWN_TODO_KEY,
  FORGE_PROJECT_LABEL_TIMEOUT_MS,
  FORGE_TOOL_REQUEST_ID_PREFIX,
  execFile,
} from "./backend-registry-runtime-helpers";
import type {
  ForgeToolRuleWriter,
  ForgeWriteApprovalNotes,
  LocalPullRequestAuthorityResolver,
  PendingServerRequest,
  ProjectForgeAutomationHandler,
  PullRequestReferenceResolver,
  TaskMonitorDelegationRecord,
  ThreadPrWatchesPeerHandler,
  ThreadPullRequestCanonicalizer,
  ThreadPullRequestDetachHandler,
  ThreadPullRequestRefreshHandler,
  ThreadPullRequestStatusToolHandler,
  ThreadPullRequestWatchToolHandler,
} from "./backend-registry-types";
import type { RegistryContext } from "./registry-context";
import {
  normalizePositivePullRequestNumber,
  parseGitRemoteRepositoryUrl,
  pullRequestRepositoryKey,
} from "./thread-forge-helpers";
import { buildActiveTurnKey, buildPendingRequestKey } from "./thread-turn-keys";

// The registry's logger name, so moved log lines read as they did.
const backendRegistryLog = getMainLogger("pwragent:backend-registry");

/** The forge and PR bindings the composition root supplies at construction. */
export type ForgeToolBridgeHandlers = Pick<RegistryHandlers,
  | "localForgeReadHandler"
  | "forgeReadHandler"
  | "forgePrToolHandler"
  | "forgePrToolPreflight"
  | "forgeToolPolicyResolver"
  | "forgeToolRuleWriter"
  | "forgeProjectLabelResolver"
  | "threadPullRequestStatusToolHandler"
  | "threadPullRequestCanonicalizer"
  | "pullRequestReferenceResolver"
  | "threadProjectRepositoryResolver"
  | "threadPrimaryGitRepositoryReader"
  | "localPullRequestAuthorityResolver"
  | "threadPullRequestWatchToolHandler"
  | "threadPullRequestDetachHandler"
  | "threadPrWatchesPeerHandler"
  | "projectForgeAutomationHandler"
  | "threadPullRequestRefreshHandler"
>;

/**
 * Registry-owned state and turn queries the forge tools read. The registry
 * passes closures over itself; this module never imports the registry.
 */
export interface ForgeToolBridgeHost {
  readonly pendingServerRequests: Map<string, PendingServerRequest>;
  readonly activeCodexTurnCollaborationModes: Map<string, AppServerCollaborationModeRequest["mode"]>;
  readonly threadTodoHandler: PwrAgentThreadTodoHandler | undefined;
  resolveCodexModelProvidersFn(): CodexModelProviderSettings[];
  findHeadlessAutomationTurnForRequest(
    backend: AppServerBackendKind,
    request: AppServerPendingRequestNotification,
  ): { executionMode?: ThreadExecutionMode } | undefined;
  getActiveTurnForThread(params: { backend: AppServerBackendKind; threadId: string }): { turnId: string } | undefined;
  isTaskMonitorThread(context: { backend: AppServerBackendKind; threadId: string }): boolean;
  taskMonitorForThread(context: { backend: AppServerBackendKind; threadId: string }): TaskMonitorDelegationRecord | undefined;
  isMcpGatewayFullAccess(context: AgentToolCallContext, automationMode?: ThreadExecutionMode): Promise<boolean>;
  resolveCodexToolCallExecutionMode(
    context: AgentToolCallContext,
    automationMode?: ThreadExecutionMode,
  ): Promise<ThreadExecutionMode | undefined>;
  resolveClaudeToolCallExecutionMode(
    threadId: string,
    automationMode?: ThreadExecutionMode,
  ): Promise<ThreadExecutionMode | undefined>;
  readThreadInspectionSummaryForMutation(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<ThreadInspectionSummary | undefined>;
  publishLocalEvent(event: AgentEvent): Promise<void>;
}

/**
 * The PR and forge domain of the backend registry: the gated forge read and
 * write tools with their approval cards and project rules, the PR handler
 * bindings the app-server service supplies, attaching a PR to a thread, and
 * canonicalizing a thread's PR chips through the status registry.
 */
export class ForgeToolBridge {
  private readonly context: RegistryContext;
  private readonly host: ForgeToolBridgeHost;

  constructor(context: RegistryContext, handlers: ForgeToolBridgeHandlers, host: ForgeToolBridgeHost) {
    this.context = context;
    this.host = host;
    this.localForgeReadHandler = handlers.localForgeReadHandler;
    this.forgeReadHandler = handlers.forgeReadHandler;
    this.forgePrToolHandler = handlers.forgePrToolHandler;
    this.forgePrToolPreflight = handlers.forgePrToolPreflight;
    this.forgeToolPolicyResolver = handlers.forgeToolPolicyResolver;
    this.forgeToolRuleWriter = handlers.forgeToolRuleWriter;
    this.forgeProjectLabelResolver = handlers.forgeProjectLabelResolver;
    this.threadPullRequestStatusToolHandler = handlers.threadPullRequestStatusToolHandler;
    this.threadPullRequestCanonicalizer = handlers.threadPullRequestCanonicalizer;
    this.pullRequestReferenceResolver = handlers.pullRequestReferenceResolver;
    this.threadProjectRepositoryResolver = handlers.threadProjectRepositoryResolver;
    this.threadPrimaryGitRepositoryReader = handlers.threadPrimaryGitRepositoryReader;
    this.localPullRequestAuthorityResolver = handlers.localPullRequestAuthorityResolver;
    this.threadPullRequestWatchToolHandler = handlers.threadPullRequestWatchToolHandler;
    this.threadPullRequestDetachHandler = handlers.threadPullRequestDetachHandler;
    this.threadPrWatchesPeerHandler = handlers.threadPrWatchesPeerHandler;
    this.projectForgeAutomationHandler = handlers.projectForgeAutomationHandler;
    this.threadPullRequestRefreshHandler = handlers.threadPullRequestRefreshHandler;
  }

  private forgeReadHandler?: ForgeReadHandler;
  private localForgeReadHandler?: ForgeReadHandler;

  setForgeReadHandlers(local: ForgeReadHandler, routed: ForgeReadHandler): void {
    this.localForgeReadHandler = local;
    this.forgeReadHandler = routed;
  }

  private forgePrToolHandler?: ForgePrToolHandler;
  private forgePrToolPreflight?: ForgePrToolPreflight;
  private forgeToolPolicyResolver?: () => ForgeAgentToolPolicy;
  private forgeToolRuleWriter?: ForgeToolRuleWriter;
  private forgeProjectLabelResolver?: (repository: string) => Promise<string | undefined>;
  /** Conversation grants for forge writes, keyed by thread, then tool and repository. Memory only. */
  private readonly forgeToolSessionApprovals = new Map<string, Map<string, string>>();

  /**
   * `preflight` names the repository on an approval card, fills in what the
   * call would otherwise infer (a pull request's head), and fails a bad call
   * before asking.
   */
  setForgePrToolHandler(handler: ForgePrToolHandler, preflight?: ForgePrToolPreflight): void {
    this.forgePrToolHandler = handler;
    this.forgePrToolPreflight = preflight;
  }

  setForgeToolPolicyResolver(resolve: () => ForgeAgentToolPolicy): void {
    this.forgeToolPolicyResolver = resolve;
  }

  /** Saves the project rule an approval card's "Always allow" option chose. */
  setForgeToolRuleWriter(write: ForgeToolRuleWriter): void {
    this.forgeToolRuleWriter = write;
  }

  /** Names a repository's project as the Directories lens does. */
  setForgeProjectLabelResolver(resolve: (repository: string) => Promise<string | undefined>): void {
    this.forgeProjectLabelResolver = resolve;
  }

  resolveForgeToolPolicy(): ForgeAgentToolPolicy {
    try {
      return this.forgeToolPolicyResolver?.() ?? DEFAULT_FORGE_AGENT_TOOL_POLICY;
    } catch (error) {
      // An unreadable policy must not widen access: treat the family as off.
      backendRegistryLog.warn("could not read forge tool policy", { error: String(error) });
      return { ...DEFAULT_FORGE_AGENT_TOOL_POLICY, enabled: false };
    }
  }

  /** Refuses a call the operator's policy removed, even from a turn holding an older schema. */
  private assertForgeToolAllowed(group: ForgeAgentToolGroup, tool: string): ForgeAgentToolAccess {
    const policy = this.resolveForgeToolPolicy();
    if (!policy.enabled) {
      throw new ForgeReadError("tools_disabled", `Forge tools are off in Settings → Git → Agent forge tools, so ${tool} is unavailable. Ask the operator to turn them on; do not work around the setting with the gh or glab CLI.`);
    }
    const access = policy.access[group];
    if (access === "off") {
      throw new ForgeReadError("tools_disabled", `${FORGE_AGENT_TOOL_GROUP_LABELS[group]} is Off in Settings → Git → Agent forge tools, so ${tool} is unavailable. Ask the operator to change the setting; do not work around it with the gh or glab CLI.`);
    }
    return access;
  }

  readonly gatedForgeReadHandler: ForgeReadHandler = async (operation, args, context) => {
    context = this.resolveTaskMonitorForgeContext(context, true);
    this.assertForgeToolAllowed("read", operation);
    if (!this.forgeReadHandler) throw new ForgeReadError("unavailable", "Forge read tools are unavailable on this instance.");
    return await this.forgeReadHandler(operation, args, context);
  };

  readonly gatedForgePrToolHandler: ForgePrToolHandler = async (operation, args, context) => {
    const group = forgePrToolGroup(operation, args);
    context = this.resolveTaskMonitorForgeContext(context, group === "read");
    this.assertForgeToolAllowed(group, operation);
    let target = args;
    let notes: ForgeWriteApprovalNotes | undefined;
    if (group !== "read") {
      // Settle the call before asking: an approved call that then fails on its
      // arguments makes the agent retry and the operator approve it twice.
      const prepared = this.forgePrToolPreflight ? await this.forgePrToolPreflight(operation, args, context) : undefined;
      const repository = prepared?.repository ?? args.repository;
      let settled = prepared?.args ?? args;
      const approval = await this.approveForgeToolWrite(operation, settled, context, group, repository, prepared?.mergeMethods, prepared?.mergeQueue);
      notes = approval.notes;
      // The operator's pick from the merge menu replaces the settled method.
      if (approval.mergeMethod) settled = { ...settled, method: approval.mergeMethod };
      // Act exactly where the card said, even if the thread's remotes or branch change while it waits.
      target = repository ? { ...settled, repository } : settled;
    }
    if (!this.forgePrToolHandler) throw new ForgeReadError("unavailable", "Forge tools are unavailable on this instance.");
    const result = withForgeApprovalNotes(await this.forgePrToolHandler(operation, target, context), notes);
    if (operation === "create_pull_request") return await this.attachCreatedPullRequest(result, context);
    return result;
  };

  /** Link a PR the agent just opened, so its chip and status appear without a branch lookup. */
  private async attachCreatedPullRequest(result: unknown, context: AgentToolCallContext): Promise<unknown> {
    const url = readRecord(result)?.url;
    if (typeof url !== "string") return result;
    try {
      // The forge just returned this URL, so it already names the repository.
      const attached = await this.handleAttachThreadPullRequestInspectionRequest(
        { backend: context.backend, threadId: context.threadId, url },
        { forgeUrl: true },
      );
      return { ...readRecord(result), attachedToThread: attached.ok };
    } catch (error) {
      backendRegistryLog.warn("could not attach created pull request", { threadId: context.threadId, error: String(error) });
      return { ...readRecord(result), attachedToThread: false };
    }
  }

  /**
   * Which agent is making a forge call, from PwrAgent's own records and never
   * from the call's arguments. A Codex thread's provider is the one Codex
   * reported, configured in PwrAgent or not; `openai` is the default. A
   * provider Codex has not reported is unknown, never assumed to be the
   * default, so a Codex rule can restrict that thread but not loosen it. A
   * model that cannot be read is unknown, so rules naming a model do not
   * apply, while agent and provider rules still do.
   */
  private async resolveForgeAgentIdentity(context: AgentToolCallContext): Promise<ForgeAgentIdentity> {
    const { backend, threadId } = context;
    let codexModelProvider: string | undefined;
    let codexModelProviderKnown = false;
    if (backend === "codex") {
      try {
        // A configured provider is reported too; the second read covers a
        // client that only tracks those.
        const reported = this.context.providers.codex.reportedModelProviderForThread?.(threadId)
          ?? this.context.providers.codex.modelProviderForThread?.(threadId);
        if (reported?.trim()) {
          codexModelProvider = reported.trim();
          codexModelProviderKnown = true;
        }
      } catch (error) {
        backendRegistryLog.warn("could not read the thread's Codex model provider for forge rules", { threadId, error: String(error) });
      }
    }
    let model: string | undefined;
    try {
      if (isAcpBackendId(backend)) {
        model = this.context.providers.acp.getSession(backend, threadId)?.acpRuntime?.currentModelId?.trim() || undefined;
      }
      if (model === undefined) {
        // The default desktop adapter uses the shared owner port. Older injected
        // overlay adapters can still supply the desktop model projection.
        const metadata = this.context.stores.threads.getThreadMetadata
          ? await this.context.stores.threads.getThreadMetadata({ backend, threadId })
          : await this.context.stores.threads.getThreadOverlayState({ backend, threadId });
        model = metadata?.model?.trim() || undefined;
      }
    } catch (error) {
      model = undefined;
      backendRegistryLog.warn("could not read the thread's model for forge rules", { backend, threadId, error: String(error) });
    }
    if (backend === "codex" && model) {
      // A qualified id names the provider; rules compare the bare model id.
      const parsed = parseCodexProviderModelId(model);
      if (!codexModelProviderKnown && parsed.providerId) {
        codexModelProvider = parsed.providerId;
        codexModelProviderKnown = true;
      }
      model = parsed.model || undefined;
    }
    return {
      backend,
      ...(codexModelProvider ? { codexModelProvider } : {}),
      ...(backend === "codex" && !codexModelProviderKnown ? { codexModelProviderUnknown: true } : {}),
      ...(model ? { model } : {}),
    };
  }

  /** `ruleRepositoryProjectLabel` for a forge call's repository. */
  private async forgeProjectLabel(repository: ForgeRepository | undefined): Promise<string | undefined> {
    if (!repository) return undefined;
    const fallback = `${repository.owner}/${repository.repo}`;
    const key = normalizeForgeRuleRepository(repository);
    return key ? await this.ruleRepositoryProjectLabel(key, fallback) : fallback;
  }

  /** Display names for rule wording: installed ACP agents and Codex model providers. */
  private forgeAgentRuleNames(): ForgeAgentRuleNames {
    return {
      acpAgent: (registryId) => {
        const backendId = `acp:${registryId}`;
        return isAcpBackendId(backendId) ? this.context.providers.acp.getInstalledAgent(backendId)?.name : undefined;
      },
      codexModelProvider: (providerId) => {
        try {
          return this.host.resolveCodexModelProvidersFn().find((provider) => provider.id === providerId)?.name;
        } catch {
          return undefined;
        }
      },
    };
  }

  /**
   * The operator's consent for one GitHub write. The level comes from the
   * most specific project rule for this repository and agent, else the
   * group's setting. Plan turns refuse every write before considering the
   * level. `allow` runs; `auto` follows the turn's approval mode
   * (see `forgeAutoRunsWithoutApproval`); otherwise the shipped MCP approval
   * card asks. Automations cannot answer, so they are refused with the
   * setting to change.
   */
  private async approveForgeToolWrite(
    operation: ForgePrToolOperation,
    args: ForgePrToolArgs,
    context: AgentToolCallContext,
    group: ForgeAgentToolGroup,
    repository?: ForgeRepository,
    mergeMethods?: ForgePrToolPreflightResult["mergeMethods"],
    mergeQueue?: ForgePrToolPreflightResult["mergeQueue"],
  ): Promise<{ notes?: ForgeWriteApprovalNotes; mergeMethod?: ThreadTodoMergeMethod }> {
    if (this.isForgePlanTurn(context)) {
      throw new ForgeReadError("plan_mode", claudePlanTurnRefusal(operation));
    }
    const identity = await this.resolveForgeAgentIdentity(context);
    const resolution = resolveForgeAgentToolAccess(this.resolveForgeToolPolicy(), group, repository, identity);
    const access = resolution.level;
    const rule = resolution.source === "project_rule" ? resolution.rule : undefined;
    // What the agent reads names the repository; what the operator reads
    // names the project, as the sidebar and Settings do.
    const wording = {
      ...(repository ? { projectLabel: `${repository.owner}/${repository.repo}` } : {}),
      names: this.forgeAgentRuleNames(),
    };
    if (access === "off") {
      if (rule) {
        throw new ForgeReadError("tools_disabled", `${forgeAgentToolRuleOffMessage(rule, group, wording)} Do not work around it with the gh or glab CLI.`);
      }
      // The setting changed while the call was prepared.
      this.assertForgeToolAllowed(group, operation);
      throw new ForgeReadError("tools_disabled", `${FORGE_AGENT_TOOL_GROUP_LABELS[group]} is Off in Settings → Git → Agent forge tools, so ${operation} is unavailable.`);
    }
    if (access === "allow") {
      if (!rule) return {};
      const description = forgeAgentToolRuleDescription(rule, wording);
      backendRegistryLog.info("running forge write allowed by a project rule", {
        backend: context.backend,
        threadId: context.threadId,
        turnId: context.turnId,
        operation,
        rule: description,
      });
      return { notes: { approval: { source: FORGE_AGENT_RULE_APPROVAL_SOURCE, rule: description } } };
    }
    const signal = context.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const label = FORGE_AGENT_TOOL_GROUP_LABELS[group];
    const levelName = access === "auto" ? "Auto" : "Ask";
    const requestId = `${FORGE_TOOL_REQUEST_ID_PREFIX}${randomUUID()}`;
    const forge = repository?.provider === "gitlab" ? "GitLab" : "GitHub";
    // Comment-sized changes may be granted for the conversation; opening,
    // editing, approving and merging are always one call at a time.
    const sessionGrant = group === "comments" || group === "issues";
    const grantNote = sessionGrant
      ? " A conversation grant lasts until PwrAgent restarts or the setting changes."
      : " This allows this call only.";
    const meta: Record<string, unknown> = {
      pwragent_approval_kind: "mcp_tool_call",
      ...(sessionGrant ? { persist: ["session"] } : {}),
      ...(repository ? { connector_name: `${repository.owner}/${repository.repo}` } : {}),
      ...(group === "approve_merge" ? { riskLevel: "high" } : {}),
      // `subtitle` is set below, once the call is known to need a card.
      tool_params_display: forgeToolParamsDisplay(args),
    };
    const notification: AppServerPendingRequestNotification = {
      method: "mcpServer/elicitation/request",
      params: {
        threadId: context.threadId,
        turnId: context.turnId ?? "",
        requestId,
        serverName: forge,
        mode: "form",
        message: forgeToolApprovalMessage(operation, args, repository?.provider ?? "github", mergeQueue),
        requestedSchema: { type: "object", properties: {} },
        _meta: meta,
      },
    };
    const automation = this.host.findHeadlessAutomationTurnForRequest(context.backend, notification);
    if (access === "auto" && await this.forgeAutoRunsWithoutApproval(group, context, automation)) {
      signal.throwIfAborted();
      backendRegistryLog.info("running Auto forge write without an approval card", {
        backend: context.backend,
        threadId: context.threadId,
        turnId: context.turnId,
        operation,
        ...(rule ? { rule: forgeAgentToolRuleDescription(rule, wording) } : {}),
      });
      return {};
    }
    if (automation) {
      throw new ForgeReadError("approval_required", rule
        ? `${forgeAgentToolRuleSentence(rule, group, access, wording)} An automation cannot answer an approval. The operator can set the rule to Allow in Settings → Git → Agent forge tools.`
        : resolution.source === "unreadable_rule"
          ? `${forgeAgentToolUnreadableRuleSentence(resolution.repository, group, wording)} An automation cannot answer an approval.`
          : `${label} is set to ${levelName} in Settings → Git → Agent forge tools, and an automation cannot answer an approval. The operator can set it to Allow.`);
    }
    if (!context.turnId) {
      throw new ForgeReadError("approval_required", `${label} needs the operator's approval, which requires an active turn.`);
    }
    const sessionKey = JSON.stringify([context.backend, context.threadId]);
    // A grant covers one tool in one repository, never every repository the
    // thread links, and ends when the level that asked, or the rule that set
    // it, changes.
    const grantTarget = `${operation}\u0000${repository ? repositoryKey(repository) : ""}`;
    const grantKey = `${group}:${access}${rule
      ? `:${rule.repository}:${forgeAgentRuleAgentKey(rule.agent)}`
      : resolution.source === "unreadable_rule" ? ":unreadable" : ""}`;
    if (sessionGrant && this.forgeToolSessionApprovals.get(sessionKey)?.get(grantTarget) === grantKey) return {};
    const cardWording = { ...wording, projectLabel: await this.forgeProjectLabel(repository) };
    signal.throwIfAborted();
    meta.subtitle = rule
      ? `${forgeAgentToolRuleSentence(rule, group, access, cardWording)}${grantNote}`
      : resolution.source === "unreadable_rule"
        ? `${forgeAgentToolUnreadableRuleSentence(resolution.repository, group, cardWording)}${grantNote}`
        : `${label} is set to ${levelName} in Settings → Git → Agent forge tools.${grantNote}`;
    // "Always allow" choices for this card. Only offered options can be
    // chosen, and only for this request.
    const ruleRepository = repository ? normalizeForgeRuleRepository(repository) : undefined;
    const rememberOptions = ruleRepository
      ? buildForgeApprovalRememberOptions({
        group,
        repository: ruleRepository,
        identity,
        resolution,
        automation: false,
        projectLabel: cardWording.projectLabel,
        names: cardWording.names,
      })
      : [];
    if (rememberOptions.length > 0) meta[FORGE_APPROVAL_REMEMBER_OPTIONS_META_KEY] = rememberOptions;
    // A merge names its method on the button and offers the others, as a
    // to-do merge card does. The settled method is the button's.
    const offeredMergeMethods = mergeMethods && args.method && mergeMethods.offered.includes(args.method)
      ? mergeMethods.offered
      : undefined;
    // A queue picks its own method: the card asks to add the PR to it instead.
    if (mergeQueue) {
      meta[FORGE_APPROVAL_MERGE_QUEUE_META_KEY] = mergeQueue satisfies ForgeApprovalMergeQueue;
    } else if (offeredMergeMethods && args.method) {
      meta[FORGE_APPROVAL_MERGE_METHODS_META_KEY] = {
        selected: args.method,
        methods: offeredMergeMethods,
      } satisfies ForgeApprovalMergeMethods;
    }
    const key = buildPendingRequestKey({ backend: context.backend, threadId: context.threadId, requestId });
    type Approval = {
      grant: "once" | "session";
      remember?: ForgeApprovalRememberOptionId;
      mergeMethod?: ThreadTodoMergeMethod;
    } | false;
    const approved = await new Promise<Approval>((resolve, reject) => {
      const finish = (value: Approval, error?: unknown): void => {
        signal.removeEventListener("abort", aborted);
        this.host.pendingServerRequests.delete(key);
        if (error) reject(error);
        else resolve(value);
      };
      const aborted = (): void => {
        finish(false, signal.reason);
        void this.context.emit({ backend: context.backend, notification: {
          method: "serverRequest/resolved", params: { threadId: context.threadId, turnId: context.turnId, requestId },
        } }).catch(() => undefined);
      };
      this.host.pendingServerRequests.set(key, {
        backend: context.backend, notification,
        resolve: (response) => {
          if (signal.aborted) { aborted(); return; }
          const accepted = Boolean(response && "action" in response && response.action === "accept");
          if (!accepted) { finish(false); return; }
          const responseMeta = response && "_meta" in response ? readRecord(response._meta) : undefined;
          const choice = readForgeApprovalRememberChoice(responseMeta);
          const remember = choice && rememberOptions.some((option) => option.id === choice) ? choice : undefined;
          if (choice && !remember) {
            backendRegistryLog.warn("ignoring a forge remember choice this card did not offer", { threadId: context.threadId, requestId, choice });
          }
          const pickedMethod = readForgeApprovalMergeMethodChoice(responseMeta);
          const mergeMethod = pickedMethod && offeredMergeMethods?.includes(pickedMethod) ? pickedMethod : undefined;
          if (pickedMethod && !mergeMethod) {
            backendRegistryLog.warn("ignoring a merge method this card did not offer", { threadId: context.threadId, requestId, method: pickedMethod });
          }
          finish({
            grant: sessionGrant && responseMeta?.persist === "session" ? "session" : "once",
            ...(remember ? { remember } : {}),
            ...(mergeMethod ? { mergeMethod } : {}),
          });
        },
        reject: (error) => finish(false, error),
      });
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) { aborted(); return; }
      void this.context.emit({ backend: context.backend, notification }).catch((error) => finish(false, error));
    });
    if (!approved) throw new ForgeReadError("declined", `The operator declined ${operation}. Do not retry it or use the gh or glab CLI instead; ask what they want changed.`);
    if (approved.grant === "session") {
      const grants = this.forgeToolSessionApprovals.get(sessionKey) ?? new Map<string, string>();
      grants.set(grantTarget, grantKey);
      this.forgeToolSessionApprovals.set(sessionKey, grants);
    }
    if (approved.mergeMethod) {
      // A pick from the menu is the operator's preference for the project,
      // whether or not this merge succeeds, as on a to-do card.
      try {
        mergeMethods?.remember?.(approved.mergeMethod);
      } catch (error) {
        backendRegistryLog.warn("could not remember a merge method pick", { threadId: context.threadId, error: String(error) });
      }
    }
    const merge = approved.mergeMethod ? { mergeMethod: approved.mergeMethod } : {};
    if (!approved.remember || !ruleRepository || !isForgeApprovalRememberGroup(group)) return merge;
    return {
      ...merge,
      notes: {
        rememberedRule: await this.rememberForgeApprovalRule(approved.remember, {
          group, repository: ruleRepository, identity, context, wording,
        }),
      },
    };
  }

  /**
   * Save the project rule an approval card's "Always allow" option chose,
   * before the approved call runs. The operator approved the call either
   * way, so a failed save is reported and the call still runs once.
   */
  private async rememberForgeApprovalRule(
    optionId: ForgeApprovalRememberOptionId,
    request: {
      group: ForgeAgentToolRuleGroup;
      repository: string;
      identity: ForgeAgentIdentity;
      context: AgentToolCallContext;
      wording: { projectLabel?: string; names: ForgeAgentRuleNames };
    },
  ): Promise<NonNullable<ForgeWriteApprovalNotes["rememberedRule"]>> {
    const { group, repository, identity, context, wording } = request;
    const agent = forgeApprovalRememberRuleAgent(optionId, identity);
    const rule = agent
      ? forgeAgentToolRuleDescription({ repository, agent }, wording)
      : `${wording.projectLabel ?? forgeRuleRepositoryLabel(repository)} rule`;
    try {
      if (!agent) throw new Error("This agent cannot be named in a project rule.");
      if (!this.forgeToolRuleWriter) throw new Error("Project rules cannot be saved on this instance.");
      await this.forgeToolRuleWriter({ repository, agent, group, level: "allow" });
      backendRegistryLog.info("saved a forge project rule from an approval card", {
        backend: context.backend,
        threadId: context.threadId,
        group,
        rule,
      });
      return { rule, saved: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      backendRegistryLog.warn("could not save a forge project rule from an approval card", {
        backend: context.backend,
        threadId: context.threadId,
        group,
        rule,
        error: message,
      });
      return { rule, saved: false, error: `The operator approved this call, but the rule could not be saved, so later calls still ask: ${message}` };
    }
  }

  /**
   * A forge card the agent's turn outlived. Ending the turn cancels the call
   * and withdraws the card, yet the agent's answer may still ask the operator
   * to approve it, so the thread keeps a reminder of what was asked.
   */
  async raiseWithdrawnForgeApprovalTodo(
    backend: AppServerBackendKind,
    threadId: string,
    requests: AppServerPendingRequestNotification[],
  ): Promise<void> {
    const asked = requests.flatMap((request) => {
      const params = readRecord(request.params);
      const target = readRecord(params?._meta)?.connector_name;
      return typeof params?.message === "string"
        ? [`“${params.message}”${typeof target === "string" ? ` for ${target}` : ""}`]
        : [];
    });
    if (!this.host.threadTodoHandler || asked.length === 0) return;
    const serverName = readRecord(requests[0]?.params)?.serverName;
    const forge = typeof serverName === "string" ? serverName : "forge";
    try {
      await this.host.threadTodoHandler.add({ backend, threadId }, {
        key: FORGE_APPROVAL_WITHDRAWN_TODO_KEY,
        title: `Reply to retry the withdrawn ${forge} request`,
        detail: `The agent asked ${asked.join(" and ")}. Its turn ended before you answered, so the request was withdrawn and nothing ran.`,
      });
    } catch (error) {
      backendRegistryLog.warn("could not raise a withdrawn forge approval to-do", { backend, threadId, error: String(error) });
    }
  }

  async readForgeForPeer(request: ForgeReadRequest, signal?: AbortSignal): Promise<unknown> {
    validateForgeReadArgs(request.operation, request.args);
    // This instance's operator decides whether its threads' forge data is read, from here or a peer.
    this.assertForgeToolAllowed("read", request.operation);
    if (!isAppServerBackendKind(request.backend) || !request.threadId || request.args.instanceId) throw new ForgeReadError("invalid_arguments", "Federated forge reads require a local thread target.");
    if (!this.localForgeReadHandler) throw new ForgeReadError("unavailable", "Forge read tools are unavailable on this owner.");
    return this.localForgeReadHandler(request.operation, { ...request.args, backend: request.backend, threadId: request.threadId }, { backend: request.backend, threadId: request.threadId, transport: "mcp", signal });
  }

  private threadPullRequestStatusToolHandler:
    | ThreadPullRequestStatusToolHandler
    | undefined;
  private threadPullRequestWatchToolHandler:
    | ThreadPullRequestWatchToolHandler
    | undefined;

  private threadPullRequestDetachHandler:
    | ThreadPullRequestDetachHandler
    | undefined;
  private threadPrWatchesPeerHandler: ThreadPrWatchesPeerHandler | undefined;
  private projectForgeAutomationHandler:
    | ProjectForgeAutomationHandler
    | undefined;
  private threadPullRequestRefreshHandler:
    | ThreadPullRequestRefreshHandler
    | undefined;

  private threadPullRequestCanonicalizer:
    | ThreadPullRequestCanonicalizer
    | undefined;
  private pullRequestReferenceResolver:
    | PullRequestReferenceResolver
    | undefined;
  private localPullRequestAuthorityResolver:
    | LocalPullRequestAuthorityResolver
    | undefined;

  /** Read-only views for the registry's inspection tools and PR projections; the setters own these bindings. */
  get pullRequestStatusTool(): ThreadPullRequestStatusToolHandler | undefined {
    return this.threadPullRequestStatusToolHandler;
  }

  get pullRequestWatchTool(): ThreadPullRequestWatchToolHandler | undefined {
    return this.threadPullRequestWatchToolHandler;
  }

  get pullRequestCanonicalizer(): ThreadPullRequestCanonicalizer | undefined {
    return this.threadPullRequestCanonicalizer;
  }

  setThreadPullRequestStatusToolHandler(
    handler: ThreadPullRequestStatusToolHandler | null | undefined,
  ): void {
    this.threadPullRequestStatusToolHandler = handler ?? undefined;
  }

  setThreadPullRequestCanonicalizer(
    canonicalizer: ThreadPullRequestCanonicalizer | null | undefined,
  ): void {
    this.threadPullRequestCanonicalizer = canonicalizer ?? undefined;
  }

  setPullRequestReferenceResolver(
    resolver: PullRequestReferenceResolver | null | undefined,
  ): void {
    this.pullRequestReferenceResolver = resolver ?? undefined;
  }

  private threadPrimaryGitRepositoryReader?: (backend: AppServerBackendKind, threadId: string) => string | undefined;
  private threadProjectRepositoryResolver?: (backend: AppServerBackendKind, threadId: string) => Promise<string | undefined>;

  /** Reads a thread's primary repository when the navigation cache has none yet. */
  setThreadProjectRepositoryResolver(
    resolver: (backend: AppServerBackendKind, threadId: string) => Promise<string | undefined>,
  ): void {
    this.threadProjectRepositoryResolver = resolver;
  }

  setThreadPrimaryGitRepositoryReader(
    reader: ((backend: AppServerBackendKind, threadId: string) => string | undefined) | undefined,
  ): void {
    this.threadPrimaryGitRepositoryReader = reader;
  }

  setLocalPullRequestAuthorityResolver(
    resolver: LocalPullRequestAuthorityResolver | null | undefined,
  ): void {
    this.localPullRequestAuthorityResolver = resolver ?? undefined;
  }

  /**
   * True when this instance monitors the PR itself, so a federated
   * peer's observation of the same PR should not be applied on top of
   * ours. Defaults to false when no resolver is injected, and also
   * answers false until the first local navigation snapshot has
   * registered this instance's PR attachments — an instance that cannot
   * yet answer the question has no claim to authority, and deferring to
   * the peer beats asserting ownership we have not established.
   */
  isPullRequestLocallyMonitored(prKey: string): boolean {
    return this.localPullRequestAuthorityResolver?.(prKey) ?? false;
  }

  setThreadPullRequestWatchToolHandler(
    handler: ThreadPullRequestWatchToolHandler | null | undefined,
  ): void {
    this.threadPullRequestWatchToolHandler = handler ?? undefined;
  }

  setThreadPullRequestDetachHandler(
    handler: ThreadPullRequestDetachHandler | null | undefined,
  ): void {
    this.threadPullRequestDetachHandler = handler ?? undefined;
  }

  setThreadPrWatchesPeerHandler(
    handler: ThreadPrWatchesPeerHandler | null | undefined,
  ): void {
    this.threadPrWatchesPeerHandler = handler ?? undefined;
  }

  /** A viewer's history, Stop or Watch CI on one of this owner's threads. */
  async manageThreadPrWatchesForPeer(
    request: import("@pwragent/shared").FederationThreadPrWatchesRequestV1,
  ): Promise<import("@pwragent/shared").ThreadPrWatchesResponse> {
    const handler = this.threadPrWatchesPeerHandler;
    if (!handler) {
      return {
        ok: false,
        error: { code: "not_found", message: "PR watches are not available on this instance yet." },
      };
    }
    return await handler(request);
  }

  setProjectForgeAutomationHandler(
    handler: ProjectForgeAutomationHandler | null | undefined,
  ): void {
    this.projectForgeAutomationHandler = handler ?? undefined;
  }

  /**
   * The desktop app-server service, which validates, stores and applies a
   * peer's Forge Automation requests for this instance's projects.
   * Federation uses this mediator so its runtime does not import the IPC
   * module.
   */
  ownedProjectForgeAutomation(): ProjectForgeAutomationHandler {
    const handler = this.projectForgeAutomationHandler;
    if (!handler) {
      throw new Error("Forge Automation service is not available yet.");
    }
    return handler;
  }

  setThreadPullRequestRefreshHandler(
    handler: ThreadPullRequestRefreshHandler | null | undefined,
  ): void {
    this.threadPullRequestRefreshHandler = handler ?? undefined;
  }

  /**
   * Refresh PR state through the desktop app-server service. Federation uses
   * this mediator so its backend bridge does not import the IPC module.
   */
  async refreshOwnedThreadPullRequests(
    request: RefreshOwnedThreadPullRequestsRequest,
  ): Promise<RefreshThreadPullRequestsResponse> {
    const handler = this.threadPullRequestRefreshHandler;
    if (!handler) {
      throw new Error("Pull-request refresh service is not available yet.");
    }
    return await handler(request);
  }

  /**
   * Detach a PR attachment via the desktop app-server service. The service
   * owns the PR status registry and dispatch coordinator, so this module
   * only mediates; callers such as
   * the federation runtime use this instead of importing the IPC module.
   */
  async detachThreadPullRequest(
    params: DetachThreadPullRequestRequest,
  ): Promise<DetachThreadPullRequestResponse> {
    const handler = this.threadPullRequestDetachHandler;
    if (!handler) {
      throw new Error("Pull-request detach service is not available yet.");
    }
    return await handler(params);
  }

  /**
   * The thread's project, as a forge rule names it: its primary repository.
   * The resolver reads a thread no navigation refresh has listed yet.
   */
  async threadProjectRepository(backend: AppServerBackendKind, threadId: string): Promise<string | undefined> {
    try {
      const primary = this.threadPrimaryGitRepositoryReader?.(backend, threadId)
        ?? await this.threadProjectRepositoryResolver?.(backend, threadId);
      return primary ? normalizeForgeRuleRepository(primary) : undefined;
    } catch (error) {
      backendRegistryLog.warn("could not read a thread's project for MCP tool approval", { threadId, error: String(error) });
      return undefined;
    }
  }

  /**
   * The project's name in the Directories lens, so a card names it as the
   * sidebar and Settings do. `fallback` when no row matches or the lookup is
   * slow: a card must not wait on the directory inventory.
   */
  async ruleRepositoryProjectLabel(
    repository: string,
    fallback = forgeRuleRepositoryLabel(repository),
  ): Promise<string> {
    if (!this.forgeProjectLabelResolver) return fallback;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const label = await Promise.race([
        this.forgeProjectLabelResolver(repository),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), FORGE_PROJECT_LABEL_TIMEOUT_MS);
        }),
      ]);
      return label?.trim() || fallback;
    } catch (error) {
      backendRegistryLog.warn("could not read the project name for an approval card", { error: String(error) });
      return fallback;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  buildTaskMonitorForgeToolDefinitions(policy?: ForgeAgentToolPolicy) {
    return buildForgeToolDefinitions({
      forgeReadHandler: this.gatedForgeReadHandler,
      forgePrToolHandler: this.gatedForgePrToolHandler,
      policy,
    }).filter((tool) => tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true);
  }

  private resolveTaskMonitorForgeContext(context: AgentToolCallContext, readOnly: boolean): AgentToolCallContext {
    if (!this.host.isTaskMonitorThread(context)) return context;
    const monitor = this.host.taskMonitorForThread(context);
    if (!readOnly || !monitor || monitor.cancellation || monitor.finalizationStarted) {
      throw new ForgeReadError("forbidden", "Job Monitors may only read forge state while monitoring is active.");
    }
    // Hidden monitor threads have no repository links or attached PRs of their own.
    return { ...context, backend: monitor.parentBackend, threadId: monitor.parentThreadId, turnId: monitor.parentTurnId };
  }

  /** The live turn's plan mode is independent of its saved approval mode. */
  private isForgePlanTurn(context: AgentToolCallContext): boolean {
    if (context.backend === "claude") return this.context.providers.claude.livePermissionMode(context.threadId) === "plan";
    if (context.backend !== "codex") return false;
    const pendingKey = buildActiveTurnKey("codex", context.threadId, `pending:${context.threadId}`);
    const turnId = context.turnId ?? this.host.getActiveTurnForThread(context)?.turnId;
    const mode = turnId
      ? this.host.activeCodexTurnCollaborationModes.get(buildActiveTurnKey("codex", context.threadId, turnId))
      : undefined;
    // A dynamic call can arrive before turn/start returns its real turn id.
    return (mode ?? this.host.activeCodexTurnCollaborationModes.get(pendingKey)) === "plan";
  }

  /**
   * Whether a forge group set to Auto runs without a card in this turn.
   *
   * Auto follows the turn's approval mode. Full Access runs every group. A
   * Codex Auto turn runs every group but Approve and merge: in that mode Codex
   * lets its own reviewer clear the same work done through `gh` or its GitHub
   * connector, without a card. Codex never reviews PwrAgent's dynamic tools,
   * so asking here made the PwrAgent tool the one path that always stopped,
   * and the agent is told not to fall back to `gh`. These tools reach only
   * the thread's linked repositories. Merging and approving stay Full Access
   * only, because they cannot be taken back. A headless automation also
   * needs Full Access: nobody is watching it, and in an Auto automation no
   * reviewer would see these calls at all.
   *
   * A Claude thread follows the same rules. Bypass permissions is its Full
   * Access, and its Auto mode lets Claude's classifier clear `gh` the way
   * Codex's reviewer does.
   */
  private async forgeAutoRunsWithoutApproval(
    group: ForgeAgentToolGroup,
    context: AgentToolCallContext,
    automation?: { executionMode?: ThreadExecutionMode },
  ): Promise<boolean> {
    if (context.backend !== "codex" && context.backend !== "claude") {
      return await this.host.isMcpGatewayFullAccess(context, automation?.executionMode);
    }
    const executionMode = context.backend === "codex"
      ? await this.host.resolveCodexToolCallExecutionMode(context, automation?.executionMode)
      : await this.host.resolveClaudeToolCallExecutionMode(context.threadId, automation?.executionMode);
    if (executionMode === "full-access") return true;
    return executionMode === "auto" && group !== "approve_merge" && !automation;
  }

  async handleAttachThreadPullRequestInspectionRequest(
    args: AttachThreadPullRequestToolArgs,
    options: { forgeUrl?: boolean } = {},
  ): Promise<PwrAgentThreadInspectionResponse> {
    if (!args.backend || !isAppServerBackendKind(args.backend)) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: "backend must be a known PwrAgent backend.",
        },
      };
    }
    const threadId = args.threadId?.trim();
    if (!threadId) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: "threadId is required.",
        },
      };
    }
    const summary = await this.host.readThreadInspectionSummaryForMutation({
      backend: args.backend,
      threadId,
    });
    if (!summary) {
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Thread ${args.backend}:${threadId} was not found.`,
        },
      };
    }

    const resolved = await this.resolvePullRequestReferenceForThread(args, summary);
    if (!resolved.ok) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: resolved.message,
        },
      };
    }

    const ref = options.forgeUrl || resolved.forgeResolved
      ? resolved.ref
      : await this.resolveForgePullRequestReference(resolved.ref, summary);
    const pr: PrSummary = {
      provider: normalizePullRequestProvider(ref.provider),
      org: ref.org,
      repo: ref.repo,
      number: ref.number,
      ...(args.title?.trim() ? { title: args.title.trim() } : {}),
      state: "pending",
      checkState: "pending",
      lifecycleState: "open",
      reviewState: "ready_for_review",
      mergeState: "unknown",
      url: ref.url,
    };

    const overlay = await this.context.stores.pullRequests.addThreadPullRequestReference({
      backend: args.backend,
      threadId,
      pr,
    });
    // Rows stored before the forge named a renamed repository collapse here,
    // so the tool reply and the chips show one PR.
    const prs = (await this.projectCanonicalPullRequests(overlay))?.prs ?? [];
    await this.host.publishLocalEvent({
      backend: args.backend,
      notification: {
        method: "thread/pullRequests/updated",
        params: {
          threadId,
          prs,
        },
      },
    });

    return {
      ok: true,
      data: {
        pullRequestReference: {
          backend: args.backend,
          threadId,
          pr,
          prs,
        },
      },
    };
  }

  /**
   * The identity the forge gives a PR the agent named. Attaching never fails
   * because the forge cannot answer; it keeps the typed identity, and a later
   * lookup's by-URL refresh merges the rows.
   */
  private async resolveForgePullRequestReference(
    ref: PullRequestReferenceIdentity,
    summary: ThreadInspectionSummary,
  ): Promise<PullRequestReferenceIdentity> {
    if (!this.pullRequestReferenceResolver) return ref;
    const directory = summary.linkedDirectories[0];
    const cwd = directory?.worktreePath?.trim() || directory?.path.trim() || undefined;
    try {
      const resolved = await this.pullRequestReferenceResolver({
        url: ref.url,
        ...(cwd ? { cwd } : {}),
      });
      const parsed = parsePullRequestReferenceUrl(resolved?.url);
      if (
        !resolved
        || normalizePullRequestProvider(resolved.provider) !== normalizePullRequestProvider(ref.provider)
        || parsed?.number !== ref.number
      ) {
        return ref;
      }
      return {
        ...ref,
        provider: normalizePullRequestProvider(resolved.provider),
        org: resolved.org,
        repo: resolved.repo,
        url: resolved.url,
        ...(parsed?.kind ? { kind: parsed.kind } : {}),
        ...(parsed?.urlBase ? { urlBase: parsed.urlBase } : {}),
      };
    } catch (error) {
      backendRegistryLog.warn("could not resolve pull request reference with its forge", {
        url: ref.url,
        error: error instanceof Error ? error.message : String(error),
      });
      return ref;
    }
  }

  private async resolvePullRequestReferenceForThread(
    args: AttachThreadPullRequestToolArgs,
    summary: ThreadInspectionSummary,
  ): Promise<
    | { ok: true; ref: PullRequestReferenceIdentity; forgeResolved?: boolean }
    | { ok: false; message: string }
  > {
    const parsedUrl = parsePullRequestReferenceUrl(args.url);
    if (args.url?.trim() && !parsedUrl) {
      return {
        ok: false,
        message:
          "url must look like a GitHub/GHE /pull/<number> URL or a GitLab /merge_requests/<number> URL.",
      };
    }
    const explicitNumber = normalizePositivePullRequestNumber(args.number);
    const explicitProvider = args.provider?.trim()
      ? normalizePullRequestProvider(args.provider)
      : undefined;
    const explicitOrg = args.org?.trim();
    const explicitRepo = args.repo?.trim();
    if (parsedUrl) {
      const conflicts = [
        explicitNumber !== undefined && explicitNumber !== parsedUrl.number
          ? "number"
          : undefined,
        explicitProvider && explicitProvider !== parsedUrl.provider
          ? "provider"
          : undefined,
        // Forges fold the case of owner and repository names.
        explicitOrg && explicitOrg.toLowerCase() !== parsedUrl.org.toLowerCase()
          ? "org"
          : undefined,
        explicitRepo && explicitRepo.toLowerCase() !== parsedUrl.repo.toLowerCase()
          ? "repo"
          : undefined,
      ].filter((field): field is string => Boolean(field));
      if (conflicts.length > 0) {
        return {
          ok: false,
          message: `url conflicts with explicit ${conflicts.join(
            "/",
          )}. Provide matching PR identity fields or omit the conflicting fields.`,
        };
      }
    }

    const number = explicitNumber ?? parsedUrl?.number;
    if (!number) {
      return {
        ok: false,
        message: "number must be a positive integer unless url contains one.",
      };
    }

    const provider = explicitProvider ?? parsedUrl?.provider;
    // The URL's casing wins over fields that match it case-insensitively.
    const org = parsedUrl?.org || explicitOrg;
    const repo = parsedUrl?.repo || explicitRepo;
    if (provider && org && repo) {
      return {
        ok: true,
        ref: {
          provider,
          org,
          repo,
          number,
          url: args.url?.trim() || buildPullRequestReferenceUrl({
            provider,
            org,
            repo,
            number,
            urlBase: parsedUrl?.urlBase,
          }),
          urlBase: parsedUrl?.urlBase,
        },
      };
    }

    const inferredRepositories = await this.inferPullRequestRepositories(summary);
    if (inferredRepositories.length > 1 && this.pullRequestReferenceResolver) {
      const resolvedRepositories = await this.resolveInferredPullRequestRepositories(
        inferredRepositories,
        number,
        summary,
      );
      if (resolvedRepositories.length === 1) {
        return { ok: true, ref: resolvedRepositories[0]!, forgeResolved: true };
      }
    }
    if (inferredRepositories.length !== 1) {
      return {
        ok: false,
        message:
          inferredRepositories.length === 0
            ? "provider/org/repo are required because no repository could be inferred from the thread."
            : "provider/org/repo are required because the thread has multiple inferable repositories.",
      };
    }
    const [inferred] = inferredRepositories;
    return {
      ok: true,
      ref: {
        ...inferred,
        number,
        url: buildPullRequestReferenceUrl({ ...inferred, number }),
      },
    };
  }

  /**
   * The PR under each inferred repository, as the forge names it. A checkout
   * cloned before a rename keeps the old remote, and the forge answers the
   * old name with the new one, so both names collapse to one repository.
   * Known renames come from the alias map without a fetch. A name the forge
   * cannot place keeps its own identity, so the ambiguity stands.
   */
  private async resolveInferredPullRequestRepositories(
    repositories: readonly PullRequestRepositoryRef[],
    number: number,
    summary: ThreadInspectionSummary,
  ): Promise<PullRequestReferenceIdentity[]> {
    const answers = await Promise.all(repositories.map(async (repository) =>
      await this.resolveForgePullRequestReference(
        {
          ...repository,
          number,
          url: buildPullRequestReferenceUrl({ ...repository, number }),
        },
        summary,
      )
    ));
    const byKey = new Map<string, PullRequestReferenceIdentity>();
    for (const answer of answers) {
      const key = pullRequestRepositoryKey(answer);
      if (!byKey.has(key)) byKey.set(key, answer);
    }
    return [...byKey.values()];
  }

  private async inferPullRequestRepositories(
    summary: ThreadInspectionSummary,
  ): Promise<PullRequestRepositoryRef[]> {
    const byKey = new Map<string, PullRequestRepositoryRef>();
    for (const pr of summary.pullRequests ?? []) {
      const parsedUrl = parsePullRequestReferenceUrl(pr.url);
      const ref = {
        provider: normalizePullRequestProvider(pr.provider),
        org: pr.org,
        repo: pr.repo,
        kind: parsedUrl?.kind,
        urlBase: parsedUrl?.urlBase,
      };
      byKey.set(pullRequestRepositoryKey(ref), ref);
    }
    await Promise.all(
      summary.linkedDirectories.map(async (directory) => {
        const cwd = directory.worktreePath?.trim() || directory.path.trim();
        if (!cwd) {
          return;
        }
        const ref = await this.readPullRequestRepositoryFromGitRemote(cwd);
        if (ref) {
          const key = pullRequestRepositoryKey(ref);
          // A known PR URL is stronger evidence than an unclassified remote.
          byKey.set(key, { ...ref, kind: byKey.get(key)?.kind ?? ref.kind });
        }
      }),
    );
    return [...byKey.values()].sort((left, right) =>
      pullRequestRepositoryKey(left).localeCompare(pullRequestRepositoryKey(right)),
    );
  }

  private async readPullRequestRepositoryFromGitRemote(
    cwd: string,
  ): Promise<PullRequestRepositoryRef | undefined> {
    try {
      const result = await execFile(
        "git",
        ["-C", cwd, "config", "--get", "remote.origin.url"],
        { env: buildPwrAgentChildProcessEnv(process.env), timeout: 2_000 },
      );
      return parseGitRemoteRepositoryUrl(result.stdout);
    } catch {
      return undefined;
    }
  }

  /**
   * Project a navigation snapshot's PR chips through the canonical PR
   * status registry.
   *
   * The thread overlay stores which PRs are attached to a thread; the
   * *status* on those stored rows is only a cached projection, and the
   * background poller does not write back into it — it updates the PR
   * status registry (and its `pr_status_cache` table) and emits
   * `pullRequest/status/updated`. Every path that serves PR chips to a
   * client therefore has to canonicalize, or it hands out whatever
   * status happened to be persisted the last time the attachment list
   * was rewritten. The renderer's own snapshot path does this; so must
   * the bridge that serves federation viewers and messaging browse,
   * otherwise a viewer sees a PR that merged hours ago still rendered
   * open with checks running, and never converges — the background
   * poller drops terminal PRs from its rotation, so nothing it emits
   * will correct the stale row.
   *
   * Deliberately does less than the renderer path's
   * `applyCanonicalPrStatuses`: no seeding of the status registry from
   * the passed threads (a serving path should read the registry, not
   * write to it) and no equality check to preserve thread identity
   * (these threads are about to be serialized over IPC or federation,
   * so identity buys nothing). Keep it that way if the two are ever
   * merged.
   */
  async canonicalizeNavigationThreadPullRequests(
    threads: NavigationSnapshot["threads"],
  ): Promise<NavigationSnapshot["threads"]> {
    const primaryRepository = this.threadPrimaryGitRepositoryReader;
    if (primaryRepository) threads = threads.map((thread) => ({
      ...thread, primaryGitRepository: primaryRepository(thread.source, thread.id),
    }));
    const canonicalizer = this.threadPullRequestCanonicalizer;
    if (!canonicalizer) {
      return threads;
    }
    try {
      return await Promise.all(
        threads.map(async (thread) => {
          if (!thread.prs?.length) {
            return thread;
          }
          return { ...thread, prs: await canonicalizer(thread.prs) };
        }),
      );
    } catch (error) {
      // Canonicalizing reads the durable `pr_status_cache`. If that read
      // fails, serving the snapshot with the overlay's own PR rows is a
      // far better outcome than failing the snapshot: the client gets
      // possibly-stale chips instead of an error, and for a federation
      // viewer an error means a disconnected window rather than one
      // slightly wrong row.
      backendRegistryLog.warn("pr status canonicalization failed", {
        error: error instanceof Error ? error.message : String(error),
        threadCount: threads.length,
      });
      return threads;
    }
  }

  async projectCanonicalPullRequests(
    overlay: ThreadOverlayState | undefined,
  ): Promise<ThreadOverlayState | undefined> {
    if (!overlay?.prs?.length || !this.threadPullRequestCanonicalizer) {
      return overlay;
    }
    const prs = await this.threadPullRequestCanonicalizer(overlay.prs);
    return { ...overlay, prs };
  }
}
