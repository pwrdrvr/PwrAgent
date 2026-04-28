import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppServerReviewOutput, AppServerReviewTarget } from "@pwragnt/shared";
import type { AppServerNotification, ThreadState } from "./internal-contract.js";
import { AppServerSessionState } from "./session-state.js";
import { TurnRunner } from "./turn-runner.js";
import { readReviewPrompt } from "./review-prompt.js";
import type { AppServerProvider } from "../providers/provider-contract.js";
import type { ToolExecutor } from "../tools/tool-contract.js";

const execFileAsync = promisify(execFile);

type ReviewRunnerOptions = {
  provider: AppServerProvider;
  state: AppServerSessionState;
  emit: (notification: AppServerNotification) => Promise<void>;
  turnRunner: TurnRunner;
  tools: ToolExecutor;
};

type ReviewPromptContext = {
  displayText: string;
  prompt: string;
};

export class ReviewRunner {
  private readonly provider: AppServerProvider;
  private readonly state: AppServerSessionState;
  private readonly emit: (notification: AppServerNotification) => Promise<void>;
  private readonly turnRunner: TurnRunner;
  private readonly tools: ToolExecutor;

  constructor(options: ReviewRunnerOptions) {
    this.provider = options.provider;
    this.state = options.state;
    this.emit = options.emit;
    this.turnRunner = options.turnRunner;
    this.tools = options.tools;
  }

  async start(params: {
    thread: ThreadState;
    turnId: string;
    itemId: string;
    target: unknown;
  }): Promise<{ reviewThreadId: string; turnId: string }> {
    const context = await buildReviewPromptContext({
      replay: this.state.readThread(params.thread.threadId),
      target: normalizeReviewTarget(params.target),
      thread: params.thread,
    });

    const enteredItemId = `${params.itemId}-entered`;
    this.state.upsertItem(params.thread.threadId, {
      id: enteredItemId,
      type: "enteredReviewMode",
      status: "completed",
      review: context.displayText,
    });
    await this.emit({
      method: "item/completed",
      params: {
        threadId: params.thread.threadId,
        turnId: params.turnId,
        item: {
          id: enteredItemId,
          type: "enteredReviewMode",
          review: context.displayText,
        },
      },
    });

    const handle = await this.provider.startTurn({
      thread: params.thread,
      input: [
        {
          type: "text",
          text: context.prompt,
        },
      ],
      previousResponseId: this.state.getPreviousResponseId(params.thread.threadId),
      tools: this.tools,
    });
    this.state.createRun({
      turnId: params.turnId,
      threadId: params.thread.threadId,
      handle,
    });
    this.turnRunner.attach({
      threadId: params.thread.threadId,
      turnId: params.turnId,
      handle,
      onSuccess: async (result) => {
        const parsed = parseReviewOutput(result.assistantText);
        const reviewText = parsed
          ? formatReviewOutput(parsed)
          : result.assistantText?.trim() || "Review completed without output.";

        this.state.completeRun(params.turnId);
        this.state.upsertItem(params.thread.threadId, {
          id: params.itemId,
          type: "exitedReviewMode",
          status: "completed",
          review: reviewText,
          data: parsed ? { reviewOutput: parsed } : undefined,
        });
        this.state.setPreviousResponseId(
          params.thread.threadId,
          result.providerResponseId,
        );
        await this.emit({
          method: "item/completed",
          params: {
            threadId: params.thread.threadId,
            turnId: params.turnId,
            item: {
              id: params.itemId,
              type: "exitedReviewMode",
              review: reviewText,
              data: parsed ? { reviewOutput: parsed } : undefined,
            },
          },
        });
        await this.emit({
          method: "turn/completed",
          params: {
            threadId: params.thread.threadId,
            turnId: params.turnId,
            turn: {
              id: params.turnId,
              status: "completed",
              output: [
                {
                  type: "text",
                  text: reviewText,
                },
              ],
            },
          },
        });
      },
      onError: async (error) => {
        this.state.failRun(params.turnId);
        await this.emit({
          method: "turn/failed",
          params: {
            threadId: params.thread.threadId,
            turnId: params.turnId,
            turn: {
              id: params.turnId,
              status: "failed",
              error: {
                message: error instanceof Error ? error.message : String(error),
              },
            },
          },
        });
      },
    });
    return {
      reviewThreadId: params.thread.threadId,
      turnId: params.turnId,
    };
  }
}

function normalizeReviewTarget(value: unknown): AppServerReviewTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { type: "uncommittedChanges" };
  }

  const record = value as Record<string, unknown>;
  const rawType = typeof record.type === "string" ? record.type : "";
  if (rawType === "uncommittedChanges" || rawType === "uncommitted_changes") {
    return { type: "uncommittedChanges" };
  }
  if (rawType === "baseBranch" || rawType === "base_branch") {
    const branch =
      firstNonEmptyString(record.branch, record.baseBranch, record.base_branch) ??
      "main";
    return {
      type: "baseBranch",
      branch,
    };
  }
  if (rawType === "commit") {
    return {
      type: "commit",
      sha: firstNonEmptyString(record.sha, record.commit) ?? "HEAD",
      title: typeof record.title === "string" ? record.title : null,
    };
  }
  if (rawType === "custom") {
    return {
      type: "custom",
      instructions:
        firstNonEmptyString(record.instructions, record.prompt) ??
        "Review the requested code changes.",
    };
  }
  return { type: "uncommittedChanges" };
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

async function buildReviewPromptContext(params: {
  replay: ReturnType<AppServerSessionState["readThread"]>;
  target: AppServerReviewTarget;
  thread: ThreadState;
}): Promise<ReviewPromptContext> {
  const targetPrompt = await buildTargetPrompt(params.thread, params.target);
  const transcript = params.replay.messages
    .map((message) => `${message.role.toUpperCase()}: ${message.text}`)
    .join("\n\n");
  const prompt = [
    readReviewPrompt().trim(),
    "## Review request",
    targetPrompt.prompt,
    "## Thread transcript",
    transcript || "No prior transcript is available.",
  ].join("\n\n");

  return {
    displayText: targetPrompt.displayText,
    prompt,
  };
}

async function buildTargetPrompt(
  thread: ThreadState,
  target: AppServerReviewTarget,
): Promise<ReviewPromptContext> {
  if (target.type === "baseBranch") {
    const mergeBase = await findMergeBase(thread.cwd, target.branch);
    if (mergeBase) {
      return {
        displayText: `Review changes against ${target.branch}`,
        prompt: `Review the code changes against the base branch '${target.branch}'. The merge base commit for this comparison is ${mergeBase}. Run git diff ${mergeBase} to inspect the patch.`,
      };
    }
    return {
      displayText: `Review changes against ${target.branch}`,
      prompt: `Review the code changes against the base branch '${target.branch}'. If a merge base is needed, inspect the repository and compare the current checkout with that branch.`,
    };
  }

  if (target.type === "commit") {
    return {
      displayText: `Review commit ${target.sha}`,
      prompt: `Review commit ${target.sha}${target.title ? ` (${target.title})` : ""} and provide prioritized findings.`,
    };
  }

  if (target.type === "custom") {
    return {
      displayText: "Review custom instructions",
      prompt: target.instructions,
    };
  }

  return {
    displayText: "Review current changes",
    prompt: "Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.",
  };
}

async function findMergeBase(
  cwd: string | undefined,
  branch: string,
): Promise<string | undefined> {
  if (!cwd?.trim() || !branch.trim()) {
    return undefined;
  }
  try {
    const { stdout } = await execFileAsync("git", ["merge-base", "HEAD", branch], {
      cwd,
      timeout: 10_000,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function parseReviewOutput(text: string | undefined): AppServerReviewOutput | undefined {
  if (!text?.trim()) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.findings)) {
    return undefined;
  }
  const overallCorrectness = record.overall_correctness;
  const overallExplanation = record.overall_explanation;
  const overallConfidence = record.overall_confidence_score;
  if (
    (overallCorrectness !== "patch is correct" &&
      overallCorrectness !== "patch is incorrect") ||
    typeof overallExplanation !== "string" ||
    typeof overallConfidence !== "number"
  ) {
    return undefined;
  }

  const findings = record.findings.flatMap((finding): AppServerReviewOutput["findings"] => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      return [];
    }
    const item = finding as Record<string, unknown>;
    const location =
      item.code_location &&
      typeof item.code_location === "object" &&
      !Array.isArray(item.code_location)
        ? item.code_location as Record<string, unknown>
        : undefined;
    const lineRange =
      location?.line_range &&
      typeof location.line_range === "object" &&
      !Array.isArray(location.line_range)
        ? location.line_range as Record<string, unknown>
        : undefined;
    if (
      typeof item.title !== "string" ||
      typeof item.body !== "string" ||
      typeof item.confidence_score !== "number" ||
      typeof location?.absolute_file_path !== "string" ||
      typeof lineRange?.start !== "number" ||
      typeof lineRange?.end !== "number"
    ) {
      return [];
    }
    return [
      {
        title: item.title,
        body: item.body,
        confidence_score: item.confidence_score,
        priority: typeof item.priority === "number" ? item.priority : undefined,
        code_location: {
          absolute_file_path: location.absolute_file_path,
          line_range: {
            start: lineRange.start,
            end: lineRange.end,
          },
        },
      },
    ];
  });

  return {
    findings,
    overall_correctness: overallCorrectness,
    overall_explanation: overallExplanation,
    overall_confidence_score: overallConfidence,
  };
}

function formatReviewOutput(output: AppServerReviewOutput): string {
  const lines = [
    output.overall_explanation.trim() || output.overall_correctness,
    "",
  ];
  if (output.findings.length === 0) {
    lines.push("No findings.");
    return lines.join("\n").trim();
  }

  for (const finding of output.findings) {
    const range = finding.code_location.line_range;
    const priority = finding.priority === undefined ? "P?" : `P${finding.priority}`;
    lines.push(
      `- [${priority}] ${finding.title} (${finding.code_location.absolute_file_path}:${range.start}-${range.end})`,
      `  ${finding.body}`,
    );
  }
  return lines.join("\n").trim();
}
