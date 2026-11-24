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
import { REVIEW_OUTPUT_INSTRUCTIONS } from "../../shared/review-output";

const MANAGED_REVIEW_GUIDANCE = [
  "Approach:",
  "- Perform a static, adversarial code review. Read the complete diff, commit messages or PR intent when available, the changed files, their direct callers/tests, and governing repository rules or standards (such as AGENTS.md, CLAUDE.md, or CODING_STANDARDS.md for the changed paths) at the reviewed revision.",
  "- Stay purely static and bounded: use read-only git/file inspection only (aim for under ~15 read-only calls; batch related reads). Do not run lint, typecheck, build, or test suites, do not launch ad-hoc reproduction or runtime probe scripts, do not search the web to chase speculative framework internals, and do not audit unrelated modules. Only run a targeted read-only command if a concrete ambiguity in repository source cannot be resolved by reading files. Once the diff, direct callers/tests, and governing rules are checked, stop exploring and emit your JSON verdict.",
  "- Mentally execute the changed paths across boundary inputs, error/cancellation/cleanup paths, concurrency/ordering interleavings, and process or lifecycle boundaries.",
  "",
  "What to check:",
  "- Correctness and contracts (both regressions and newly introduced behavior): trace logic errors, invalid state transitions, race conditions, broken error propagation, resource/lifecycle leaks, dangling references to deleted or renamed files/symbols, and mismatches between stated intent and implementation. Check new APIs, fields, logs, and telemetry/metrics to verify their actual values, scope, and timing match their names and documented semantics.",
  "- Test fidelity and falsifiability: state the core bug or behavioral invariant the diff claims to fix or establish, then inspect the actual assertions in the added or updated tests (unit, property, integration, and E2E). Ask: if the core fix were reverted to the broken behavior (even while keeping the new field or type shapes), would at least one non-mocked assertion fail? Merely invoking the new code path or asserting output shapes, types, truthiness, or no-throw is not falsification: if a regression test lacks an assertion on the actual invariant being restored (or mocks away the boundary the fix changes, or checks a proxy instead of the invariant), report it, along with any missing coverage for core changed behavior or error paths.",
  "- Repository standards: flag concrete violations of explicit rules in governing repository instructions or standards files, citing the violated rule.",
  "",
  "Evidence and signal discipline:",
  "- Ground every finding in the reviewed code; check callers, guards, and surrounding context before claiming something is missing or wrong.",
  "- Lead each finding's body with the concrete observable consequence or failure scenario, explain the mechanism in the code, and propose a specific fix when clear.",
  "- Suppress noise: do not report style or formatting nitpicks, speculative hypotheticals without a reachable failure path, issues already handled elsewhere, or unrelated pre-existing issues in untouched code that the diff does not newly expose.",
  "- Zero findings is valid when the change has no concrete defects.",
].join("\n");

export function buildManagedReviewPrompt(
  target: AppServerReviewTarget,
): string {
  return [
    "Perform a code review. Do not modify files or mutate git state. Do not run commands that require elevated permissions.",
    reviewTargetInstructions(target),
    MANAGED_REVIEW_GUIDANCE,
    REVIEW_OUTPUT_INSTRUCTIONS,
  ].join("\n\n");
}

/**
 * Runtime state for a managed review child session on an ACP backend.
 *
 * Antigravity has no built-in code review command, and its `default` and
 * `plan` modes ask for approval on every terminal command including read-only
 * `git log` and `git diff` inspection. Starting the review child in
 * Antigravity's native `auto` mode lets safe inspection commands run without
 * prompting while keeping `--dangerously-skip-permissions` off; if the new
 * session does not list `auto`, `applyAcpRuntimeSelection` falls back to its
 * highest offered level at or below `auto` via `sessionStartMode`.
 */
export function managedReviewAcpRuntime(params: {
  backend: AcpBackendId;
  parentRuntime?: BackendAcpSessionRuntimeState;
  runtimeCapabilities?: BackendAcpRuntimeCapabilities;
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
  const modeConfigOption = mirroredModeOption?.values.some(
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
    currentModeId: "auto",
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
