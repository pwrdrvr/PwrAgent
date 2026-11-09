import {
  buildThreadIdentityKey,
  isAcpBackendId,
  RENAME_THREAD_EXPECTED_NAME_MISMATCH,
  shortenDerivedThreadTitle,
  type AgentEvent,
  type AppServerBackendKind,
  type AppServerRenamedTitleSource,
  type AppServerThreadSummary,
  type AppServerThreadTitleSource,
  type RenameThreadRequest,
  type RenameThreadResponse,
  type ThreadAgentMetadata,
} from "@pwragent/shared";
import type { OwnerThreadIdentity } from "./thread-storage";

// Internal owner options, never accepted from the viewer's rename request.
export type ThreadRenameOptions = {
  titleSource?: AppServerRenamedTitleSource;
  renameOrigin?: "agent_tool";
  previousThreadName?: string;
};

/** Host effects retain the provider's storage sites and transactions. */
export interface ThreadNamingHost {
  readName(identity: OwnerThreadIdentity): Promise<string | undefined>;
  readTitle(identity: OwnerThreadIdentity): Promise<AppServerThreadSummary | undefined>;
  renameProvider(request: RenameThreadRequest, titleSource: AppServerThreadTitleSource): Promise<{ threadId: string }>;
  getAgent(identity: OwnerThreadIdentity): Promise<ThreadAgentMetadata | undefined>;
  setAgent(identity: OwnerThreadIdentity, agent: Pick<ThreadAgentMetadata, "name" | "instructions">): Promise<void>;
  invalidate(backend: AppServerBackendKind): void;
  emit(event: AgentEvent): Promise<void>;
  now(): number;
}

/** Identity is checked by reference; a caller cannot recreate an admitted attempt. */
export type ThreadNamingAttempt = Readonly<{ backend: AppServerBackendKind; threadId: string }>;

export type ThreadTitleApplication = { applied: true } | {
  applied: false;
  reason: "superseded" | "ineligible";
  thread?: AppServerThreadSummary;
};

export class ThreadNamingLifecycle {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly attempts = new Map<string, ThreadNamingAttempt>();
  private readonly placeholders = new Set<string>();
  private readonly explicitRenames = new Set<string>();

  constructor(private readonly host: ThreadNamingHost) {}

  markSystemPlaceholder(identity: OwnerThreadIdentity): void {
    this.placeholders.add(this.key(identity));
  }

  hasSystemPlaceholder(identity: OwnerThreadIdentity): boolean {
    return this.placeholders.has(this.key(identity));
  }

  isEligible(identity: OwnerThreadIdentity, thread: AppServerThreadSummary | undefined, prompt: string): boolean {
    return !this.explicitRenames.has(this.key(identity))
      && isEligibleForGeneratedTitle(thread, prompt, { systemPlaceholder: this.hasSystemPlaceholder(identity) });
  }

  beginTitleGeneration(identity: OwnerThreadIdentity): ThreadNamingAttempt {
    const attempt = { ...identity };
    this.attempts.set(this.key(identity), attempt);
    return attempt;
  }

  finishTitleGeneration(attempt: ThreadNamingAttempt): void {
    const key = this.key(attempt);
    if (this.attempts.get(key) === attempt) {
      this.attempts.delete(key);
      this.placeholders.delete(key);
    }
  }

  renameThread(request: RenameThreadRequest, options?: ThreadRenameOptions): Promise<RenameThreadResponse> {
    const identity = { backend: request.backend ?? "codex", threadId: request.threadId };
    const key = this.key(identity);
    // Admission precedes every await, including an earlier rename's provider I/O.
    this.placeholders.delete(key);
    this.attempts.delete(key);
    return this.serialize(identity, () => this.applyRename(request, options));
  }

  applyGeneratedTitle(params: {
    attempt: ThreadNamingAttempt;
    prompt: string;
    title: string;
    titleSource?: "derived" | "fallback";
  }): Promise<ThreadTitleApplication> {
    return this.serialize(params.attempt, async () => {
      const { attempt } = params;
      const key = this.key(attempt);
      if (this.attempts.get(key) !== attempt) return { applied: false, reason: "superseded" };
      const latest = await this.host.readTitle(attempt);
      // An explicit rename can be admitted while this metadata read is pending.
      if (this.attempts.get(key) !== attempt) return { applied: false, reason: "superseded", thread: latest };
      if (!this.isEligible(attempt, latest, params.prompt)) return { applied: false, reason: "ineligible", thread: latest };
      const source = params.titleSource ?? "derived";
      if (isAcpBackendId(attempt.backend)) {
        // ACP generated naming has always updated only its session and event.
        const result = await this.host.renameProvider({ ...attempt, name: params.title }, source);
        await this.announce(attempt.backend, result.threadId, params.title, source);
      } else {
        await this.applyRename({ ...attempt, name: params.title }, { titleSource: "derived" });
      }
      return { applied: true };
    });
  }

  private async applyRename(request: RenameThreadRequest, options?: ThreadRenameOptions): Promise<RenameThreadResponse> {
    const backend = request.backend ?? "codex";
    const identity = { backend, threadId: request.threadId };
    if (request.expectedName !== undefined || options?.renameOrigin === "agent_tool") {
      const name = await this.host.readName(identity).catch((error: unknown) => {
        if (request.expectedName !== undefined) throw error;
        return undefined;
      });
      if (request.expectedName !== undefined && name !== request.expectedName) {
        throw new Error(RENAME_THREAD_EXPECTED_NAME_MISMATCH);
      }
      if (options?.renameOrigin === "agent_tool") options = { ...options, previousThreadName: name };
    }
    const source = options?.titleSource ?? "explicit";
    const result = await this.host.renameProvider(request, source);
    if (source === "explicit") {
      // A provider can call its prompt-derived placeholder explicit too. Keep
      // the owner's successful rename intent so even that same text stays put.
      const key = this.key(identity);
      this.explicitRenames.add(key);
      this.attempts.delete(key);
    }
    // Preserve ACP's event-before-Agent-metadata ordering.
    if (isAcpBackendId(backend)) await this.announce(backend, result.threadId, request.name, source, options);
    const renamed = { backend, threadId: result.threadId };
    const agent = await this.host.getAgent(renamed);
    if (agent) await this.host.setAgent(renamed, {
      name: request.name.trim(),
      ...(agent.instructions ? { instructions: agent.instructions } : {}),
    });
    this.host.invalidate(backend);
    if (!isAcpBackendId(backend)) await this.announce(backend, result.threadId, request.name, source, options);
    return { ...renamed, renamedAt: this.host.now() };
  }

  private async announce(
    backend: AppServerBackendKind,
    threadId: string,
    name: string,
    source: AppServerThreadTitleSource,
    options?: ThreadRenameOptions,
  ): Promise<void> {
    // ACP's replaceable prompt stopgap is fallback in storage. On the wire,
    // fallback means unnamed, so preserve the existing source omission.
    await this.host.emit({ backend, notification: {
      method: "thread/name/updated",
      params: {
        threadId,
        threadName: name.trim(),
        ...(source === "fallback" ? {} : { titleSource: source }),
        ...(options?.renameOrigin ? { renameOrigin: options.renameOrigin } : {}),
        ...(options?.previousThreadName ? { previousThreadName: options.previousThreadName } : {}),
      },
    } });
  }

  private key(identity: OwnerThreadIdentity): string {
    return buildThreadIdentityKey(identity.backend, identity.threadId);
  }

  private async serialize<T>(identity: OwnerThreadIdentity, run: () => Promise<T>): Promise<T> {
    const key = this.key(identity);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const operation = previous.then(run);
    const settled = operation.then(() => {}, () => {});
    this.queues.set(key, settled);
    try {
      return await operation;
    } finally {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    }
  }
}

export function isEligibleForGeneratedTitle(
  thread: AppServerThreadSummary | undefined,
  prompt: string,
  options?: { systemPlaceholder?: boolean },
): boolean {
  if (!thread) {
    return true;
  }
  if (isPromptPlaceholderTitle(thread.title, prompt)) {
    return true;
  }
  if (thread.titleSource === "explicit") {
    return Boolean(
      options?.systemPlaceholder
      && isGenericPlaceholderTitle(thread.title),
    );
  }
  if (isInjectedContextPlaceholderTitle(thread.title)) {
    return true;
  }
  if (thread.titleSource === "fallback") {
    return (
      !isAcpBackendId(thread.source) ||
      isAcpFallbackPlaceholderTitle(thread.title)
    );
  }
  const derivedTitle = shortenDerivedThreadTitle(prompt) ?? prompt;
  return normalizeTitleForComparison(thread.title) === normalizeTitleForComparison(derivedTitle);
}

function normalizeTitleForComparison(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export function isPromptPlaceholderTitle(title: string, prompt: string): boolean {
  const normalizedTitle = normalizeTitleForComparison(title);
  const normalizedPrompt = normalizeTitleForComparison(prompt);
  const derivedTitle = shortenDerivedThreadTitle(prompt) ?? prompt;
  return (
    normalizedTitle === normalizedPrompt ||
    normalizedTitle === normalizeTitleForComparison(derivedTitle)
  );
}

export function isInjectedContextPlaceholderTitle(title: string): boolean {
  const normalizedTitle = normalizeTitleForComparison(title);
  return (
    normalizedTitle.startsWith("# agents.md instructions") ||
    normalizedTitle.startsWith("agents.md instructions for")
  );
}

function isAcpFallbackPlaceholderTitle(title: string): boolean {
  const normalizedTitle = normalizeTitleForComparison(title);
  return normalizedTitle === "acp session";
}

function isGenericPlaceholderTitle(title: string): boolean {
  const normalizedTitle = normalizeTitleForComparison(title);
  return normalizedTitle === "untitled thread";
}

