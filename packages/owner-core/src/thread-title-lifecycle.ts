import {
  buildThreadIdentityKey,
  isAcpBackendId,
  shortenDerivedThreadTitle,
  type AcpBackendId,
  type AppServerBackendKind,
  type AppServerThreadSummary,
  type AppServerTurnInputItem,
} from "@pwragent/shared";
import { ThreadNamingLifecycle, type ThreadNamingAttempt } from "./thread-naming-lifecycle";
import type { OwnerThreadIdentity } from "./thread-storage";
import type { ThreadTitleGenerationResult } from "./thread-title-generation-service";

export type ThreadTitleHelperResult = Extract<ThreadTitleGenerationResult, { status: "generated" | "invalid" }>;
export type ThreadTitleLifecycleLogStatus = ThreadTitleGenerationResult["status"] | "applied" | "requesting" | "skipped";
export type ThreadTitleHelperUpdate = OwnerThreadIdentity & {
  existingOnly?: boolean;
  result?: ThreadTitleHelperResult;
  status: "running" | "success" | "failed" | "cancelled";
  reason?: string;
};

/** Provider execution, diagnostics and existing persistence stay in the host. */
export interface ThreadTitleLifecycleHost {
  canGenerateTitle(backend: AppServerBackendKind): boolean;
  generateTitle(params: OwnerThreadIdentity & { userPrompt: string }): Promise<ThreadTitleGenerationResult | undefined>;
  readTitle(identity: OwnerThreadIdentity): Promise<AppServerThreadSummary | undefined>;
  prepareHelper(identity: OwnerThreadIdentity): Promise<void>;
  persistHelper(update: ThreadTitleHelperUpdate): Promise<void>;
  log(status: ThreadTitleLifecycleLogStatus, params: OwnerThreadIdentity & { prompt: string }, reason?: string, details?: {
    eligibility?: boolean;
    thread?: AppServerThreadSummary;
    promptTitle?: boolean;
    generatedTitle?: string;
    cachedTokens?: number | null;
  }): void;
}

/** Process-local title admission and work coordination, independent of a host. */
export class ThreadTitleLifecycle {
  private readonly attempted = new Set<string>();
  private readonly pendingInputs = new Map<string, AppServerTurnInputItem[]>();
  private readonly work = new Set<Promise<void>>();

  constructor(private readonly naming: ThreadNamingLifecycle, private readonly host: ThreadTitleLifecycleHost) {}

  rememberPendingInput(identity: OwnerThreadIdentity, input: AppServerTurnInputItem[]): void {
    this.pendingInputs.set(this.key(identity), input);
  }

  forgetPendingInput(identity: OwnerThreadIdentity): void {
    this.pendingInputs.delete(this.key(identity));
  }

  schedulePending(identity: OwnerThreadIdentity): void {
    const input = this.pendingInputs.get(this.key(identity));
    if (!input) return;
    this.forgetPendingInput(identity);
    this.schedule({ ...identity, input });
  }

  schedule(params: OwnerThreadIdentity & { input: AppServerTurnInputItem[] }): void {
    if (!this.host.canGenerateTitle(params.backend)) return;
    const prompt = extractFirstMeaningfulTextInput(params.input);
    if (!prompt) return;
    const key = this.key(params);
    if (this.attempted.has(key)) return;
    this.attempted.add(key);
    const namingAttempt = this.naming.beginTitleGeneration(params);
    const work = this.generateAndApply({ ...params, prompt, namingAttempt });
    this.work.add(work);
    // Register cleanup on both outcomes without creating an unobserved rejected
    // finally promise. whenSettled still observes the original work's outcome.
    void work.then(() => this.work.delete(work), () => this.work.delete(work));
  }

  async whenSettled(): Promise<void> {
    // A successful title event can admit another identity while this batch is
    // settling. Completion means the accepted work is empty, not ten passes.
    while (this.work.size > 0) await Promise.all([...this.work]);
  }

  private key(identity: OwnerThreadIdentity): string {
    return buildThreadIdentityKey(identity.backend, identity.threadId);
  }

  private async generateAndApply(params: {
    namingAttempt: ThreadNamingAttempt;
    backend: AppServerBackendKind;
    threadId: string;
    prompt: string;
  }): Promise<void> {
    let generatedResult: Extract<ThreadTitleGenerationResult, { status: "generated" }> | undefined;
    try {
      const currentThread = await this.host.readTitle(params);
      if (!this.naming.isEligible(params, currentThread, params.prompt)) {
        this.host.log(
          "skipped",
          params,
          "current_title_not_eligible",
          { eligibility: true, thread: currentThread }
        );
        await this.host.persistHelper({
          existingOnly: true,
          backend: params.backend,
          threadId: params.threadId,
          status: "cancelled",
          reason: "Current title is no longer eligible.",
        });
        return;
      }

      // Claude's adapter requests its own native title. Keep a local prompt
      // fallback eligible for session_info_update, without another model call.
      if (params.backend === "acp:claude") {
        if (currentThread?.titleSource !== "explicit") await this.applyPromptDerivedTitle({
          backend: params.backend, threadId: params.threadId, prompt: params.prompt, namingAttempt: params.namingAttempt,
        });
        return;
      }

      if (params.backend === "codex" || isAcpBackendId(params.backend)) {
        await this.host.prepareHelper(params);
      }
      this.host.log("requesting", params, undefined, {
        promptTitle: true,
      });
      const result = await this.host.generateTitle({
        backend: params.backend,
        threadId: params.threadId,
        userPrompt: params.prompt,
      });
      if (!result || result.status !== "generated") {
        this.host.log(
          result?.status ?? "unavailable",
          params,
          result?.reason ?? "title_generation_unavailable"
        );
        await this.host.persistHelper({
          existingOnly: true,
          backend: params.backend,
          threadId: params.threadId,
          ...(result?.status === "invalid" ? { result } : {}),
          status: "failed",
          reason: result?.reason ?? "title_generation_unavailable",
        });
        if (isAcpBackendId(params.backend)) {
          await this.applyPromptDerivedTitle({
            backend: params.backend,
            threadId: params.threadId,
            prompt: params.prompt,
            namingAttempt: params.namingAttempt,
          });
        }
        return;
      }
      generatedResult = result;
      this.host.log("generated", params, undefined, {
        generatedTitle: result.title,
        cachedTokens: result.cachedTokens ?? null,
      });

      const application = await this.naming.applyGeneratedTitle({
        attempt: params.namingAttempt,
        prompt: params.prompt,
        title: result.title,
      });
      if (!application.applied) {
        this.host.log("skipped", params,
          application.reason === "superseded" ? "stale_generation" : "latest_title_not_eligible",
          { eligibility: true, thread: application.thread });
        await this.host.persistHelper({
          existingOnly: true,
          backend: params.backend,
          threadId: params.threadId,
          result,
          status: "success",
          reason: application.thread
            ? buildLateTitleCancellationReason(params.backend, application.thread)
            : "The thread was renamed before title application.",
        });
        return;
      }
      await this.host.persistHelper({
        backend: params.backend,
        threadId: params.threadId,
        result,
        status: "success",
      });
      this.host.log("applied", params, undefined, {
        generatedTitle: result.title,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (generatedResult) {
        await this.host.persistHelper({
          backend: params.backend,
          threadId: params.threadId,
          result: generatedResult,
          status: "failed",
          reason,
        });
      } else {
        await this.host.persistHelper({
          existingOnly: true,
          backend: params.backend,
          threadId: params.threadId,
          status: "failed",
          reason,
        });
      }
      this.host.log(
        "failed",
        params,
        reason
      );
    } finally {
      this.naming.finishTitleGeneration(params.namingAttempt);
    }
  }

  private async applyPromptDerivedTitle(params: {
    backend: AcpBackendId;
    threadId: string;
    prompt: string;
    namingAttempt: ThreadNamingAttempt;
  }): Promise<void> {
    const title = shortenDerivedThreadTitle(params.prompt);
    if (!title) return;
    const applied = await this.naming.applyGeneratedTitle({
      attempt: params.namingAttempt, prompt: params.prompt, title, titleSource: "fallback",
    });
    if (applied.applied) this.host.log("applied", params, "prompt_derived_fallback", {
      generatedTitle: title,
    });
  }
}

export function extractFirstMeaningfulTextInput(input: AppServerTurnInputItem[]): string | undefined {
  const text = input
    .filter((item): item is Extract<AppServerTurnInputItem, { type: "text" }> => item.type === "text")
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n");
  return text || undefined;
}

function buildLateTitleCancellationReason(
  backend: AppServerBackendKind,
  thread: AppServerThreadSummary,
): string {
  if (thread.titleSource === "explicit") {
    return `The thread was explicitly renamed first: ${thread.title}.`;
  }
  if (isAcpBackendId(backend)) {
    return `ACP provided a durable title first: ${thread.title}.`;
  }
  return `A newer thread title was already present: ${thread.title}.`;
}
