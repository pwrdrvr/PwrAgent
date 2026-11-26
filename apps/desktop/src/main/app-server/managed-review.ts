import { findAcpMirroredModeConfigOption } from "@pwragent/shared/acp-permission-mode";
import type {
  BackendAcpRuntimeCapabilities,
  BackendAcpSessionRuntimeState,
} from "@pwragent/shared/contracts/backend";
import type {
  AcpBackendId,
  AppServerReviewTarget,
} from "@pwragent/shared/contracts/normalized-app-server";
import {
  MANAGED_REVIEW_CONTEXT_CLOSE_MARKER,
  reviewTargetInstructions,
  MANAGED_REVIEW_CONTEXT_OPEN_MARKER,
} from "../../shared/review-command";
import {
  REVIEW_OUTPUT_INSTRUCTIONS,
  REVIEW_OUTPUT_TOOL_INSTRUCTIONS,
} from "../../shared/review-output";
import managedReviewLedgerGuidanceMarkdown from "./managed-review-guidance-ledger.md?raw";
import managedReviewStaticGuidanceMarkdown from "./managed-review-guidance-static.md?raw";

function normalizeGuidanceMarkdown(markdown: string): string {
  return markdown.replace(/\r\n/gu, "\n").trim();
}

const MANAGED_REVIEW_LEDGER_GUIDANCE = normalizeGuidanceMarkdown(
  managedReviewLedgerGuidanceMarkdown,
);

const MANAGED_REVIEW_STATIC_GUIDANCE = normalizeGuidanceMarkdown(
  managedReviewStaticGuidanceMarkdown,
);

export type BuildManagedReviewPromptOptions = {
  /**
   * Include the two-pass in-memory candidate ledger workflow when the review
   * child has `record_review_candidate`, `list_review_candidates`,
   * `dispose_review_candidate`, and `submit_review_output` attached.
   */
  candidateLedger?: boolean;
  pinnedPatchFile?: string;
};

export function buildManagedReviewPrompt(
  target: AppServerReviewTarget,
  options?: BuildManagedReviewPromptOptions,
): string {
  const useLedgerTools = options?.candidateLedger === true;
  const instructions = options?.pinnedPatchFile && target.type === "pullRequest" && target.snapshot
    ? `Review the pinned change from ${target.snapshot.mergeBaseCommit} to ${target.snapshot.headCommit}. Open ${JSON.stringify(options.pinnedPatchFile)} in the review workspace with a file-reading tool and use it as the complete diff.`
    : reviewTargetInstructions(target);
  return [
    "Perform a code review. Do not modify files or mutate git state. Do not run commands that require elevated permissions.",
    instructions,
    useLedgerTools
      ? MANAGED_REVIEW_LEDGER_GUIDANCE
      : MANAGED_REVIEW_STATIC_GUIDANCE,
    useLedgerTools
      ? REVIEW_OUTPUT_TOOL_INSTRUCTIONS
      : REVIEW_OUTPUT_INSTRUCTIONS,
  ].join("\n\n");
}

/**
 * Runtime state for a managed review child session on an ACP backend.
 *
 * Antigravity has no built-in code review command, and its `default` and
 * `plan` modes ask for approval on every terminal command including read-only
 * `git log` and `git diff` inspection. Operator-requested reviews select
 * native `auto`, with the usual session start fallback if it is unavailable.
 * Agent-requested reviews confirm the caller's mode during session creation,
 * before replaying the remaining runtime options here.
 */
export function managedReviewAcpRuntime(params: {
  backend: AcpBackendId;
  parentRuntime?: BackendAcpSessionRuntimeState;
  runtimeCapabilities?: BackendAcpRuntimeCapabilities;
  requireCallerMode?: boolean;
  now?: number;
}): BackendAcpSessionRuntimeState | undefined {
  if (params.backend !== "acp:antigravity") {
    return params.parentRuntime;
  }
  const modeOptionIds = new Set(
    params.runtimeCapabilities?.configOptions
      ?.filter((option) => option.category === "mode")
      .map((option) => option.id),
  );
  modeOptionIds.add("mode");
  const preservedConfigValues = params.parentRuntime?.configValues
    ? Object.fromEntries(
        Object.entries(params.parentRuntime.configValues).filter(
          ([optionId]) => !modeOptionIds.has(optionId),
        ),
      )
    : undefined;
  const mirroredModeOption = findAcpMirroredModeConfigOption(
    params.runtimeCapabilities,
  );
  const modeConfigOption = !params.requireCallerMode && mirroredModeOption?.values.some(
    (value) => value.value === "auto",
  )
    ? mirroredModeOption
    : undefined;
  const configValues = modeConfigOption
    ? { ...preservedConfigValues, [modeConfigOption.id]: "auto" }
    : preservedConfigValues && Object.keys(preservedConfigValues).length > 0
      ? preservedConfigValues
      : undefined;
  const {
    configValues: _ignoredConfigValues,
    currentModeId: _ignoredModeId,
    ...rest
  } = params.parentRuntime ?? {};
  return {
    ...rest,
    ...(configValues ? { configValues } : {}),
    ...(!params.requireCallerMode ? { currentModeId: "auto" } : {}),
    updatedAt: params.now ?? Date.now(),
  };
}

export function buildManagedReviewContextInput(outputs: string[]): string {
  return [
    MANAGED_REVIEW_CONTEXT_OPEN_MARKER,
    ...outputs.map((output, index) => [
      outputs.length > 1 ? `Review ${index + 1}:` : undefined,
      output.trim(),
    ].filter((line): line is string => Boolean(line)).join("\n")),
    MANAGED_REVIEW_CONTEXT_CLOSE_MARKER,
  ].join("\n\n");
}
