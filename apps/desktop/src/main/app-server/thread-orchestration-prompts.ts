import { pathToFileURL } from "node:url";
import { toTranscriptImageProtocolUrl } from "../transcript-images";
import {
  type AppServerReviewTarget,
  type AppServerThreadImagePart,
  type AppServerTurnInputItem,
  type CodexEnvironmentStartupFailure,
  type HandoffThreadWorkspaceResponse,
  type PendingThreadWorkspaceMoveSummary,
} from "@pwragent/shared";
import { type ThreadAssetOwner } from "./thread-assets";
import { stageTurnInputAttachmentsForRetention } from "./turn-input-attachment-files";



export function buildHandoffTaskPrompt(params: {
  task: string;
  context?: string;
  codexEnvironmentStartupFailure?: CodexEnvironmentStartupFailure;
}): string {
  const lines = [
    "You are a PwrAgent handoff thread created by another PwrAgent thread.",
    "",
    "Task:",
    params.task,
    "",
    "Workspace ownership:",
    "Use only this thread's assigned runtime workspace for edits, builds, and Git. If a needed branch is checked out elsewhere, repoint this workspace to its commit (detached is fine); do not operate in the other worktree.",
    "Before opening or attaching a PR, verify this workspace contains its head. Attaching a PR does not rebind the workspace.",
    ...(params.codexEnvironmentStartupFailure
      ? [
          "",
          "Codex environment startup:",
          `- Status: failed`,
          `- Phase: ${params.codexEnvironmentStartupFailure.phase}`,
          `- Message: ${params.codexEnvironmentStartupFailure.message}`,
          `- Worktree cleanup available: ${
            params.codexEnvironmentStartupFailure.worktreeCleanupAvailable
              ? "yes"
              : "no"
          }`,
        ]
      : []),
  ];
  const trimmedContext = params.context?.trim();
  if (trimmedContext) {
    lines.push("", "Additional context from parent:", trimmedContext);
  }
  return lines.join("\n");
}

export function buildWorkspaceMoveSuccessPrompt(params: {
  move: PendingThreadWorkspaceMoveSummary;
  result: HandoffThreadWorkspaceResponse;
}): string {
  return [
    "PwrAgent workspace move completed for this thread.",
    "",
    "Workspace result:",
    `- Source path: ${params.move.sourcePath ?? "unknown"}`,
    `- Repository path: ${params.result.repositoryPath}`,
    `- New runtime cwd: ${
      params.result.linkedDirectory.worktreePath ?? params.result.targetPath
    }`,
    `- Target path: ${params.result.targetPath}`,
    ...(params.result.branch ? [`- Branch: ${params.result.branch}`] : []),
    ...(params.result.warnings.length
      ? ["", "Warnings:", ...params.result.warnings.map((warning) => `- ${warning}`)]
      : []),
    "",
    "Continue the user's task from the new runtime workspace. Do not repeat the workspace move.",
  ].join("\n");
}

export function describeReviewTarget(target: AppServerReviewTarget): string {
  switch (target.type) {
    case "pullRequest":
      return `pull request ${target.url}`;
    case "uncommittedChanges":
      return "uncommitted changes";
    case "baseBranch":
      return `changes against ${target.branch}`;
    case "commit":
      return `commit ${target.sha}`;
    case "custom":
      return "custom review instructions";
  }
}

/**
 * Identifies a set of failed starts by what a person would read: the target
 * and the error. A pull request target also carries a snapshot stamped with
 * the time it was taken, which differs on every attempt.
 */
export function reviewStartFailureFingerprint(
  failures: Array<{ error: string; target: AppServerReviewTarget }>,
): string {
  return JSON.stringify(
    failures.map((failure) => [describeReviewTarget(failure.target), failure.error]),
  );
}

export function buildReviewStartFailurePrompt(
  failures: Array<{ error: string; target: AppServerReviewTarget }>,
): string {
  return [
    failures.length === 1
      ? "PwrAgent could not start the review scheduled for the end of the last turn."
      : "PwrAgent could not start the reviews scheduled for the end of the last turn.",
    "",
    ...failures.flatMap((failure) => [
      `- Target: ${describeReviewTarget(failure.target)}`,
      `  Error: ${failure.error}`,
    ]),
    "",
    "No review is running. Tell the operator that the review did not start and why. Call start_review again only if you can change what caused the error.",
  ].join("\n");
}

export function buildWorkspaceMoveFailurePrompt(params: {
  error: unknown;
  move: PendingThreadWorkspaceMoveSummary;
}): string {
  const message = params.error instanceof Error ? params.error.message : String(params.error);
  return [
    "PwrAgent workspace move failed for this thread.",
    "",
    "Workspace result:",
    `- Source path: ${params.move.sourcePath ?? "unknown"}`,
    `- Repository path: ${params.move.repositoryPath ?? "unknown"}`,
    `- Error: ${message}`,
    "",
    "The original runtime workspace remains authoritative. Continue only after deciding whether to retry the move, choose another source path, or proceed in the original workspace.",
  ].join("\n");
}

export async function pendingThreadMessageImageParts(
  input: AppServerTurnInputItem[] | undefined,
  owner: ThreadAssetOwner,
): Promise<AppServerThreadImagePart[]> {
  const materializedInput = await stageTurnInputAttachmentsForRetention(input ?? [], { owner });
  return materializedInput.flatMap((item): AppServerThreadImagePart[] => {
    if (item.type === "localImage") {
      return [{
        type: "image",
        ...(item.name ? { alt: item.name } : {}),
        url: toTranscriptImageProtocolUrl(pathToFileURL(item.path).toString()),
      }];
    }
    if (item.type === "image") {
      return [{
        type: "image",
        ...(item.name ? { alt: item.name } : {}),
        url: item.url,
      }];
    }
    return [];
  });
}

export function contentHasRenderableImage(content: unknown[]): boolean {
  return content.some((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const item = value as Record<string, unknown>;
    return (
      (item.type === "image"
        || item.type === "input_image"
        || item.type === "image_url")
      && (typeof item.url === "string" || typeof item.image_url === "string")
    );
  });
}
