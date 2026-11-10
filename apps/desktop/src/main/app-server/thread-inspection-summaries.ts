import {
  buildThreadMarkdownLink,
  buildThreadUrl,
  type AppServerThreadEntry,
  type AppServerThreadMessage,
  type AppServerThreadSummary,
  type AppServerBackendKind,
  type LinkedDirectorySummary,
  type NavigationThreadSummary,
  type SetThreadModelSettingsRequest,
  type MessagingThreadBindingSummary,
  type MutateThreadToolArgs,
  type PendingThreadHandoffSummary,
  type PendingThreadWorkspaceMoveSummary,
  type PwrAgentThreadInspectionErrorCode,
  type PwrAgentThreadInspectionResponse,
  type ThreadReadEntrySummary,
  type ThreadReadMessageSummary,
  type ThreadInspectionSummary,
  type ThreadSearchFilters,
  type ThreadSearchResult,
  type ThreadExecutionMode,
  type ThreadOverlayState,
  buildThreadIdentityKey,
  isAppServerBackendKind,
} from "@pwragent/shared";
import { PwrAgentFederatedThreadInspectionError } from "../agent-tools/pwragent-thread-agent-tools";
import {
  dedupeLinkedDirectoriesByNormalizedIdentity,
} from "./linked-directory-identity";


export function threadInspectionFailure(
  code: PwrAgentThreadInspectionErrorCode,
  message: string,
): PwrAgentThreadInspectionResponse {
  return {
    ok: false,
    error: { code, message },
  };
}

export function federatedThreadInspectionFailure(
  error: unknown,
): PwrAgentThreadInspectionResponse {
  const message = error instanceof Error ? error.message : String(error);
  return threadInspectionFailure(
    error instanceof PwrAgentFederatedThreadInspectionError
      ? error.code
      : /not found/i.test(message)
        ? "not_found"
        : "internal_error",
    message,
  );
}

export function readThreadInspectionBackend(
  value: unknown,
): AppServerBackendKind | "all" | undefined {
  if (value === undefined || value === "all") {
    return "all";
  }
  return typeof value === "string" && isAppServerBackendKind(value)
    ? value
    : undefined;
}

export const DEFAULT_THREAD_INSPECTION_READ_LIMIT = 10;
export const MAX_THREAD_INSPECTION_READ_LIMIT = 20;
/** How far `mutate_thread` follows parent links when it checks for a loop. */
export const MAX_THREAD_PARENT_CHECK_DEPTH = 64;
export const DEFAULT_THREAD_INSPECTION_READ_ENTRY_CHARS = 4_000;
export const MAX_THREAD_INSPECTION_READ_ENTRY_CHARS = 20_000;

export function toThreadReadMessageSummary(
  message: AppServerThreadMessage,
  maxCharsPerEntry: number,
  threadLinkRef: {
    backend: AppServerBackendKind;
    instanceId?: string;
    threadId: string;
  },
  title?: string,
): ThreadReadMessageSummary {
  const text = truncateThreadInspectionTextWithFlag(
    message.text,
    maxCharsPerEntry,
  );
  return {
    id: message.id,
    role: message.role,
    ...(message.origin ? { origin: message.origin } : {}),
    ...(message.createdAt !== undefined ? { createdAt: message.createdAt } : {}),
    text: text.value,
    ...buildThreadMessageLinks(threadLinkRef, message.id, title),
    ...(text.truncated ? { truncated: true } : {}),
  };
}

export function toThreadReadEntrySummary(
  entry: AppServerThreadEntry,
  maxCharsPerEntry: number,
  threadLinkRef: {
    backend: AppServerBackendKind;
    instanceId?: string;
    threadId: string;
  },
  title?: string,
): ThreadReadEntrySummary {
  switch (entry.type) {
    case "message": {
      const text = truncateThreadInspectionTextWithFlag(
        entry.text,
        maxCharsPerEntry,
      );
      return {
        type: "message",
        id: entry.id,
        role: entry.role,
        ...(entry.origin ? { origin: entry.origin } : {}),
        text: text.value,
        ...(entry.createdAt !== undefined ? { createdAt: entry.createdAt } : {}),
        ...(entry.phase ? { phase: entry.phase } : {}),
        ...(entry.turn ? { turn: entry.turn } : {}),
        ...buildThreadMessageLinks(threadLinkRef, entry.id, title),
        ...(text.truncated ? { truncated: true } : {}),
      };
    }
    case "activity": {
      const summary = truncateThreadInspectionTextWithFlag(
        entry.summary,
        maxCharsPerEntry,
      );
      const details = entry.details.slice(0, 10).map((detail) => {
        const markdown = detail.markdown
          ? truncateThreadInspectionTextWithFlag(detail.markdown, maxCharsPerEntry)
          : undefined;
        const output = detail.command?.output
          ? truncateThreadInspectionTextWithFlag(
              detail.command.output,
              maxCharsPerEntry,
            )
          : undefined;
        return {
          id: detail.id,
          kind: detail.kind,
          label: truncateThreadInspectionText(detail.label, 320),
          ...(markdown ? { markdown: markdown.value } : {}),
          ...(detail.path ? { path: detail.path } : {}),
          ...(detail.url ? { url: detail.url } : {}),
          ...(detail.status ? { status: detail.status } : {}),
          ...(detail.command
            ? {
                command: {
                  displayCommand: detail.command.displayCommand,
                  ...(detail.command.rawCommand
                    ? { rawCommand: detail.command.rawCommand }
                    : {}),
                  ...(detail.command.source
                    ? { source: detail.command.source }
                    : {}),
                  ...(detail.command.cwd ? { cwd: detail.command.cwd } : {}),
                  ...(output ? { output: output.value } : {}),
                  ...(detail.command.exitCode !== undefined
                    ? { exitCode: detail.command.exitCode }
                    : {}),
                  ...(detail.command.durationMs !== undefined
                    ? { durationMs: detail.command.durationMs }
                    : {}),
                },
              }
            : {}),
          ...(summary.truncated || markdown?.truncated || output?.truncated
            ? { truncated: true }
            : {}),
        };
      });
      return {
        type: "activity",
        id: entry.id,
        summary: summary.value,
        ...(entry.createdAt !== undefined ? { createdAt: entry.createdAt } : {}),
        ...(entry.status ? { status: entry.status } : {}),
        ...(entry.turn ? { turn: entry.turn } : {}),
        details,
        ...(summary.truncated || entry.details.length > details.length
          ? { truncated: true }
          : {}),
      };
    }
    case "plan": {
      const explanation = entry.explanation
        ? truncateThreadInspectionTextWithFlag(
            entry.explanation,
            maxCharsPerEntry,
          )
        : undefined;
      const markdown = entry.markdown
        ? truncateThreadInspectionTextWithFlag(entry.markdown, maxCharsPerEntry)
        : undefined;
      const steps = entry.steps.slice(0, 20).map((step) => ({
        step: truncateThreadInspectionText(step.step, 500),
        status: step.status,
      }));
      return {
        type: "plan",
        id: entry.id,
        ...(entry.createdAt !== undefined ? { createdAt: entry.createdAt } : {}),
        ...(explanation ? { explanation: explanation.value } : {}),
        ...(markdown ? { markdown: markdown.value } : {}),
        ...(entry.turn ? { turn: entry.turn } : {}),
        steps,
        ...(explanation?.truncated ||
        markdown?.truncated ||
        entry.steps.length > steps.length
          ? { truncated: true }
          : {}),
      };
    }
    case "review": {
      const review = truncateThreadInspectionTextWithFlag(
        entry.review,
        maxCharsPerEntry,
      );
      const displayText = entry.displayText
        ? truncateThreadInspectionTextWithFlag(
            entry.displayText,
            maxCharsPerEntry,
          )
        : undefined;
      return {
        type: "review",
        id: entry.id,
        ...(entry.createdAt !== undefined ? { createdAt: entry.createdAt } : {}),
        ...(entry.status ? { status: entry.status } : {}),
        review: review.value,
        ...(displayText ? { displayText: displayText.value } : {}),
        ...(entry.turn ? { turn: entry.turn } : {}),
        ...(review.truncated || displayText?.truncated
          ? { truncated: true }
          : {}),
      };
    }
  }
}

export function buildThreadMessageLinks(
  threadLinkRef: {
    backend: AppServerBackendKind;
    instanceId?: string;
    threadId: string;
  },
  messageId: string,
  title?: string,
): { messageUrl: string; messageLink: string } {
  const messageLinkRef = { ...threadLinkRef, messageId };
  return {
    messageUrl: buildThreadUrl(messageLinkRef),
    messageLink: buildThreadMarkdownLink({
      ...messageLinkRef,
      title,
    }),
  };
}

export function isThreadMutationExecutionMode(
  value: unknown,
): value is ThreadExecutionMode {
  return value === "default" || value === "auto" || value === "full-access";
}

export function readThreadMutationModelSettings(
  args: MutateThreadToolArgs,
):
  | {
      value: Omit<SetThreadModelSettingsRequest, "backend" | "threadId">;
      error?: never;
    }
  | { value?: never; error: string }
  | { value?: undefined; error?: undefined } {
  const settings: Omit<SetThreadModelSettingsRequest, "backend" | "threadId"> = {};
  const stringFields = [
    ["model", "model"],
    ["serviceTier", "serviceTier"],
    ["reasoningEffort", "reasoningEffort"],
  ] as const;

  for (const [inputField, outputField] of stringFields) {
    if (!Object.hasOwn(args, inputField)) {
      continue;
    }
    const value = args[inputField];
    if (typeof value !== "string" || !value.trim()) {
      return {
        error: `${inputField} must be a non-empty string when provided.`,
      };
    }
    settings[outputField] = value.trim();
  }

  if (Object.hasOwn(args, "fastMode")) {
    if (typeof args.fastMode !== "boolean") {
      return {
        error: "fastMode must be a boolean when provided.",
      };
    }
    settings.fastMode = args.fastMode;
  }

  return Object.keys(settings).length > 0 ? { value: settings } : {};
}

export function clampInteger(
  value: unknown,
  defaultValue: number,
  maxValue: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultValue;
  }
  return Math.max(1, Math.min(maxValue, Math.floor(value)));
}

export function filterThreadInspectionSummaries(
  threads: ThreadInspectionSummary[],
  options: { agentOnly: boolean; query?: string },
): ThreadInspectionSummary[] {
  const clauses = parseThreadInspectionQuery(options.query);
  return threads
    .filter((thread) => !options.agentOnly || Boolean(thread.agent))
    .map((thread) => ({
      score: scoreThreadInspectionSummary(thread, clauses),
      thread,
    }))
    .filter((entry) => clauses.length === 0 || entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        (right.thread.updatedAt ?? right.thread.createdAt ?? 0) -
          (left.thread.updatedAt ?? left.thread.createdAt ?? 0),
    )
    .map((entry) => entry.thread);
}

export function normalizeThreadInspectionSearchRanks(
  threads: ThreadInspectionSummary[],
): ThreadInspectionSummary[] {
  return threads.map((thread, index) => ({
    ...thread,
    score: 1 / (index + 1),
  }));
}

export function toThreadInspectionSummary(
  thread: AppServerThreadSummary,
  overlay: ThreadOverlayState | undefined,
  messagingBindings: MessagingThreadBindingSummary[] | undefined,
): ThreadInspectionSummary {
  const linkedDirectories = dedupeLinkedDirectoriesByNormalizedIdentity(
    [
      ...(overlay?.extraLinkedDirectories ?? []),
      ...thread.linkedDirectories,
    ],
  );
  return {
    backend: thread.source,
    threadId: thread.id,
    title: thread.title,
    summary: thread.summary,
    projectKey: thread.projectKey,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    agent: overlay?.agent,
    ...(overlay?.tokenMiserEnabled !== undefined
      ? { tokenMiserEnabled: overlay.tokenMiserEnabled }
      : {}),
    ...(overlay?.monitorJobSuggestionsEnabled !== undefined
      ? { monitorJobSuggestionsEnabled: overlay.monitorJobSuggestionsEnabled }
      : {}),
    handoffOrigin: overlay?.handoffOrigin,
    executionMode: thread.executionMode,
    model: thread.model,
    reasoningEffort: thread.reasoningEffort,
    serviceTier: thread.serviceTier,
    fastMode: thread.fastMode,
    gitWorkingState: thread.gitWorkingState,
    ...(messagingBindings?.length ? { messagingBindings } : {}),
    linkedDirectories,
    linkedRepositories: summarizeLinkedRepositories(linkedDirectories),
    ...(overlay?.prs?.length ? { pullRequests: overlay.prs } : {}),
  };
}

export function toThreadInspectionSummaryFromNavigation(
  thread: NavigationThreadSummary,
): ThreadInspectionSummary {
  return {
    ...toThreadInspectionSummary(thread, undefined, thread.messagingBindings),
    agent: thread.agent,
    handoffOrigin: thread.handoffOrigin,
    ...(thread.prs?.length ? { pullRequests: thread.prs } : {}),
  };
}

export function toThreadInspectionSummaryFromSearchResult(
  result: ThreadSearchResult,
  overlay: ThreadOverlayState | undefined,
  messagingBindings: MessagingThreadBindingSummary[] | undefined,
): ThreadInspectionSummary {
  const linkedDirectories = dedupeLinkedDirectoriesByNormalizedIdentity(
    [
      ...(overlay?.extraLinkedDirectories ?? []),
      ...result.linkedDirectories,
    ],
  );
  return {
    backend: result.backend,
    threadId: result.threadId,
    title: result.title,
    summary: result.summary,
    projectKey: result.projectKey,
    createdAt: result.createdAt,
    updatedAt: result.updatedAt,
    archivedAt: result.archivedAt,
    agent: overlay?.agent,
    ...(overlay?.tokenMiserEnabled !== undefined
      ? { tokenMiserEnabled: overlay.tokenMiserEnabled }
      : {}),
    ...(overlay?.monitorJobSuggestionsEnabled !== undefined
      ? { monitorJobSuggestionsEnabled: overlay.monitorJobSuggestionsEnabled }
      : {}),
    handoffOrigin: overlay?.handoffOrigin,
    model: result.model,
    linkedDirectories,
    linkedRepositories: summarizeLinkedRepositories(linkedDirectories),
    ...(overlay?.prs?.length ? { pullRequests: overlay.prs } : {}),
    ...(messagingBindings?.length ? { messagingBindings } : {}),
    score: result.score,
    confidence: result.confidence,
    matchReasons: result.matchReasons,
    snippets: result.snippets,
  };
}

export function dedupeThreadInspectionThreadSummaries(
  threads: AppServerThreadSummary[],
): AppServerThreadSummary[] {
  const seen = new Set<string>();
  const deduped: AppServerThreadSummary[] = [];
  for (const thread of threads) {
    const key = buildThreadIdentityKey(thread.source, thread.id);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(thread);
  }
  return deduped;
}

export function parseThreadInspectionQuery(query: string | undefined): string[][] {
  const trimmed = query?.trim().toLowerCase();
  if (!trimmed) {
    return [];
  }
  return trimmed
    .split(/\s+(?:or)\s+|[|,]/i)
    .map((clause) =>
      clause
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean),
    )
    .filter((tokens) => tokens.length > 0);
}

export function pendingThreadHandoffMatchesQuery(
  handoff: PendingThreadHandoffSummary,
  clauses: string[][],
): boolean {
  if (clauses.length === 0) {
    return true;
  }
  const haystack = [
    handoff.handoffId,
    handoff.sourceBackend,
    handoff.sourceThreadId,
    handoff.sourceTurnId,
    handoff.backend,
    handoff.threadId,
    handoff.turnId,
    handoff.title,
    handoff.taskPreview,
    handoff.seedMode,
    handoff.groupingMode,
    handoff.workspaceMode,
    handoff.branchName,
    handoff.workspace?.cwd,
    handoff.workspace?.branch,
    handoff.workspace?.linkedDirectory?.label,
    handoff.workspace?.linkedDirectory?.path,
    handoff.workspace?.linkedDirectory?.worktreePath,
    handoff.message,
    handoff.error,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
  return clauses.some((tokens) => tokens.every((token) => haystack.includes(token)));
}

export function pendingThreadWorkspaceMoveMatchesQuery(
  move: PendingThreadWorkspaceMoveSummary,
  clauses: string[][],
): boolean {
  if (clauses.length === 0) {
    return true;
  }
  const haystack = [
    move.workspaceMoveId,
    move.sourceBackend,
    move.sourceThreadId,
    move.sourceTurnId,
    move.backend,
    move.threadId,
    move.status,
    move.phase,
    move.direction,
    move.strategy,
    move.repositoryPath,
    move.sourcePath,
    move.sourceBranch,
    move.leaveLocalBranch,
    move.newBranchName,
    move.baseRef,
    move.targetPath,
    move.branch,
    move.linkedDirectory?.label,
    move.linkedDirectory?.path,
    move.linkedDirectory?.worktreePath,
    move.message,
    move.error,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
  return clauses.some((tokens) => tokens.every((token) => haystack.includes(token)));
}

export function scoreThreadInspectionSummary(
  thread: ThreadInspectionSummary,
  clauses: string[][],
): number {
  if (clauses.length === 0) {
    return 0;
  }
  const title = thread.title.toLowerCase();
  const project = `${thread.projectKey ?? ""} ${thread.linkedDirectories
    .flatMap((directory) => [
      directory.label,
      directory.path,
      directory.worktreePath,
    ])
    .filter(Boolean)
    .join(" ")}`.toLowerCase();
  const haystack = [
    thread.backend,
    thread.threadId,
    thread.title,
    thread.summary,
    thread.projectKey,
    thread.agent?.name,
    thread.agent?.instructions,
    ...thread.linkedDirectories.flatMap((directory) => [
      directory.label,
      directory.path,
      directory.worktreePath,
    ]),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();

  let bestScore = 0;
  for (const tokens of clauses) {
    if (!tokens.every((token) => haystack.includes(token))) {
      continue;
    }
    const phrase = tokens.join(" ");
    const exactTitle = title.includes(phrase) ? 100 : 0;
    const allTitleTokens = tokens.every((token) => title.includes(token))
      ? 75
      : 0;
    const exactProject = project.includes(phrase) ? 60 : 0;
    const allProjectTokens = tokens.every((token) => project.includes(token))
      ? 45
      : 0;
    const exactHaystack = haystack.includes(phrase) ? 35 : 0;
    const tokenScore = Math.min(tokens.length, 5) * 5;
    bestScore = Math.max(
      bestScore,
      exactTitle ||
        allTitleTokens ||
        exactProject ||
        allProjectTokens ||
        exactHaystack ||
        tokenScore,
    );
  }
  return bestScore;
}

export function toThreadInspectionSearchSummary(
  thread: ThreadInspectionSummary,
): ThreadInspectionSummary {
  return {
    backend: thread.backend,
    threadId: thread.threadId,
    title: thread.title,
    ...(thread.summary
      ? { summary: truncateThreadInspectionText(thread.summary, 240) }
      : {}),
    ...(thread.projectKey ? { projectKey: thread.projectKey } : {}),
    ...(thread.createdAt !== undefined ? { createdAt: thread.createdAt } : {}),
    ...(thread.updatedAt !== undefined ? { updatedAt: thread.updatedAt } : {}),
    ...(thread.archivedAt !== undefined ? { archivedAt: thread.archivedAt } : {}),
    ...(thread.agent ? { agent: thread.agent } : {}),
    ...(thread.score !== undefined ? { score: thread.score } : {}),
    ...(thread.confidence ? { confidence: thread.confidence } : {}),
    ...(thread.matchReasons?.length
      ? { matchReasons: thread.matchReasons.slice(0, 6) }
      : {}),
    ...(thread.messagingBindings?.length
      ? {
          messagingBindings: thread.messagingBindings.slice(0, 5).map((binding) => ({
            bindingId: binding.bindingId,
            platform: binding.platform,
            ...(binding.conversationKind
              ? { conversationKind: binding.conversationKind }
              : {}),
            ...(binding.conversationTitle
              ? { conversationTitle: binding.conversationTitle }
              : {}),
            ...(binding.parentTitle ? { parentTitle: binding.parentTitle } : {}),
            ...(binding.ancestorTitle
              ? { ancestorTitle: binding.ancestorTitle }
              : {}),
            ...(binding.activeAt !== undefined ? { activeAt: binding.activeAt } : {}),
          })),
        }
      : {}),
    ...(thread.snippets?.length
      ? {
          snippets: thread.snippets.slice(0, 3).map((snippet) => ({
            scope: snippet.scope,
            ...(snippet.field ? { field: snippet.field } : {}),
            text: truncateThreadInspectionText(snippet.text, 360),
            ...(snippet.truncated ? { truncated: true } : {}),
          })),
        }
      : {}),
    linkedDirectories: thread.linkedDirectories.slice(0, 3).map((directory) => ({
      id: directory.id,
      kind: directory.kind,
      label: directory.label,
      path: directory.path,
      ...(directory.worktreePath ? { worktreePath: directory.worktreePath } : {}),
      ...(directory.worktreeOwnership ? { worktreeOwnership: directory.worktreeOwnership } : {}),
    })),
    ...(thread.linkedRepositories?.length
      ? {
          linkedRepositories: thread.linkedRepositories.slice(0, 5).map((repo) => ({
            repositoryPath: repo.repositoryPath,
            directoryIds: repo.directoryIds.slice(0, 8),
            labels: repo.labels.slice(0, 8),
            worktreePaths: repo.worktreePaths.slice(0, 8),
          })),
        }
      : {}),
    ...(thread.pullRequests?.length
      ? {
          pullRequests: thread.pullRequests.slice(0, 8).map((pr) => ({
            provider: pr.provider,
            org: pr.org,
            repo: pr.repo,
            number: pr.number,
            state: pr.state,
            ...(pr.checkState ? { checkState: pr.checkState } : {}),
            ...(pr.checksStillRunning ? { checksStillRunning: true } : {}),
            ...(pr.lifecycleState ? { lifecycleState: pr.lifecycleState } : {}),
            ...(pr.reviewState ? { reviewState: pr.reviewState } : {}),
            ...(pr.mergeState ? { mergeState: pr.mergeState } : {}),
            ...(pr.title ? { title: pr.title } : {}),
            url: pr.url,
          })),
        }
      : {}),
  };
}

export function summarizeLinkedRepositories(
  directories: LinkedDirectorySummary[],
): ThreadInspectionSummary["linkedRepositories"] {
  if (directories.length === 0) {
    return undefined;
  }
  const byRepositoryPath = new Map<
    string,
    NonNullable<ThreadInspectionSummary["linkedRepositories"]>[number]
  >();
  for (const directory of directories) {
    const repositoryPath = directory.path;
    const current = byRepositoryPath.get(repositoryPath) ?? {
      repositoryPath,
      directoryIds: [],
      labels: [],
      worktreePaths: [],
    };
    current.directoryIds.push(directory.id);
    if (!current.labels.includes(directory.label)) {
      current.labels.push(directory.label);
    }
    if (directory.worktreePath && !current.worktreePaths.includes(directory.worktreePath)) {
      current.worktreePaths.push(directory.worktreePath);
    }
    byRepositoryPath.set(repositoryPath, current);
  }
  return [...byRepositoryPath.values()];
}

export function nonEmptyStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

export function buildThreadInspectionDateRange(params: {
  updatedAfter?: number;
  updatedBefore?: number;
}): Pick<ThreadSearchFilters, "dateRange"> {
  const from =
    typeof params.updatedAfter === "number" && Number.isFinite(params.updatedAfter)
      ? Math.floor(params.updatedAfter)
      : undefined;
  const to =
    typeof params.updatedBefore === "number" && Number.isFinite(params.updatedBefore)
      ? Math.floor(params.updatedBefore)
      : undefined;
  return from !== undefined || to !== undefined
    ? {
        dateRange: {
          ...(from !== undefined ? { from } : {}),
          ...(to !== undefined ? { to } : {}),
        },
      }
    : {};
}

export function truncateThreadInspectionText(value: string, maxLength: number): string {
  return truncateThreadInspectionTextWithFlag(value, maxLength).value;
}

export function truncateThreadInspectionTextWithFlag(
  value: string,
  maxLength: number,
): { value: string; truncated: boolean } {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return { value: normalized, truncated: false };
  }
  return {
    value: `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`,
    truncated: true,
  };
}
