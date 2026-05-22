import {
  type ReactNode,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent as ReactFormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal, flushSync } from "react-dom";
import type { JSONContent } from "@tiptap/react";
import type {
  AppServerCollaborationModeRequest,
  AppServerReviewTarget,
  AppServerSkillSummary,
  AppServerThreadImagePart,
  AppServerTurnInputItem,
  BackendSummary,
  CodexEnvironmentActionRun,
  CodexThreadEnvironmentRuntime,
  DesktopApplicationDiscoveryCandidate,
  DesktopApplicationsSnapshot,
  DesktopChatReplyComposer,
  HandoffThreadWorkspaceRequest,
  NavigationDirectorySummary,
  NavigationLaunchpadDraft,
  NavigationLaunchpadImageAttachment,
  NavigationThreadSummary,
  ThreadWorkspaceHandoffStrategy,
  ThreadExecutionMode,
} from "@pwragent/shared";
import { readCodexEnvironmentActionRuns } from "@pwragent/shared";
import { EditorIcon, FileCodeIcon, TerminalIcon } from "../../icons";
import { formatBackendLabel } from "../../lib/backend-label";
import type { DesktopApi } from "../../lib/desktop-api";
import { formatExecutionModeLabel } from "../../lib/execution-mode";
import { normalizeImageFile } from "../../lib/image-normalization";
import type { ThreadContextWindowState } from "../../lib/useThreadSessionState";
import {
  findSkillTrigger,
  hydrateSkillLabelsWithMarkdown,
  listMentionedSkills,
  parseSkillMentionParts,
  buildSkillMentionMarkdown,
} from "../../lib/skill-mentions";
import { parseReviewCommand } from "../../../../shared/review-command";
import {
  type ComposerInputChangeMetadata,
  type ComposerInputHandle,
  type ComposerSkillToken,
} from "./ComposerInputTypes";
import { ComposerTiptapInput } from "./ComposerTiptapInput";
import { ProjectPicker } from "./ProjectPicker";
import { TranscriptCopyButton } from "../thread-detail/TranscriptCopyButton";
import {
  useComposerDraftStore,
  type ComposerDraftSnapshot,
  type ComposerDraftStore,
  type ComposerPendingSteerSnapshot,
  type ComposerQueuedTurnSnapshot,
} from "./useComposerDraftStore";

type ComposerProps = {
  activeTurnId?: string;
  addOptimisticReviewEntry?: (displayText: string) => string;
  addOptimisticUserMessage?: (
    text: string,
    imageParts?: AppServerThreadImagePart[]
  ) => string;
  backends?: BackendSummary[];
  applications?: DesktopApplicationsSnapshot;
  desktopApi?: DesktopApi;
  directory?: NavigationDirectorySummary;
  /**
   * Full set of currently-tracked directories from the navigation
   * snapshot. Used by the project picker (issue #223) to render the
   * "recent directories" list. Optional so tests / threads-only
   * surfaces don't have to provide it.
   */
  directories?: NavigationDirectorySummary[];
  disabled?: boolean;
  contextWindow?: ThreadContextWindowState;
  composerImplementation?: DesktopChatReplyComposer;
  draftStore?: ComposerDraftStore;
  launchpad?: NavigationLaunchpadDraft;
  launchpadError?: string;
  onActiveTurnIdChange?: (turnId?: string) => void;
  fullAccessRiskWarningDismissed?: boolean;
  onEnsureSkillsLoaded?: () => void | Promise<void>;
  onDismissFullAccessRiskWarning?: () => Promise<void>;
  pendingRequestActive?: boolean;
  pendingUserInputActive?: boolean;
  onMaterializeLaunchpad?: (
    directoryKey: string,
    input?: AppServerTurnInputItem[],
    collaborationMode?: AppServerCollaborationModeRequest,
    reviewTarget?: AppServerReviewTarget
  ) => Promise<void>;
  onBeforeSendTurn?: () => void;
  onPendingStatusChange?: (status?: string) => void;
  onRefreshNavigation?: () => Promise<void>;
  pastedImageMaxPatches?: number;
  onUpdateLaunchpad?: (
    directoryKey: string,
    patch: Partial<
      Pick<
        NavigationLaunchpadDraft,
        | "prompt"
        | "editorDocument"
        | "backend"
        | "executionMode"
        | "model"
        | "reasoningEffort"
        | "serviceTier"
        | "fastMode"
        | "workMode"
        | "branchName"
        | "codexEnvironmentId"
        | "codexEnvironmentExecutionTarget"
        | "codexEnvironmentSetupEnabled"
        | "codexEnvironmentActionId"
        | "directoryLabel"
        | "directoryPath"
        | "imageAttachments"
      >
    >,
    options?: { stickySettingsChanged?: boolean }
  ) => Promise<void>;
  removeOptimisticMessage?: (id: string) => void;
  /**
   * Project-directory picker plumbing (issue #223). Optional — surfaces
   * that don't render a launchpad (read-only thread views) won't pass
   * these through and the picker won't render.
   */
  onSelectDirectoryFromPicker?: (directory: NavigationDirectorySummary) => void;
  onPickAndRegisterDirectory?: () => void;
  onClearPickDirectoryError?: () => void;
  pickDirectoryError?: string;
  pickingDirectory?: boolean;
  setExecutionModeError?: string;
  skillError?: string;
  skillLoading?: boolean;
  skills: AppServerSkillSummary[];
  thread?: NavigationThreadSummary;
  updatingExecutionMode?: ThreadExecutionMode;
  onSetExecutionMode?: (executionMode: ThreadExecutionMode) => Promise<void>;
  onCancelExecutionModeQueue?: () => Promise<void>;
  onHandoffThreadWorkspace?: (
    request: Omit<HandoffThreadWorkspaceRequest, "backend" | "threadId">
  ) => Promise<void>;
  onBeforeStartTurn?: () => Promise<boolean>;
  onSetThreadModelSettings?: (
    patch: Partial<
      Pick<
      NavigationThreadSummary,
      "model" | "reasoningEffort" | "serviceTier" | "fastMode"
      >
    >
  ) => Promise<void>;
  threadModelSettingsError?: string;
};

type LocalHandoffStrategy = ThreadWorkspaceHandoffStrategy;

type ComposerImageAttachment = NavigationLaunchpadImageAttachment;

type ComposerDropdownOption = {
  disabled?: boolean;
  label: string;
  value: string;
};

type ComposerDropdownIcon = (props: { size?: number }) => ReactNode;

type QueuedTurnDraft = {
  id: string;
  input?: AppServerTurnInputItem[];
  imageAttachments: ComposerImageAttachment[];
  reviewCommand?: {
    displayText: string;
    target: AppServerReviewTarget;
  };
  text: string;
};

type PendingSteerDraft = QueuedTurnDraft & {
  status: "pending" | "steering";
};

type DeletedSkillTokenHistoryEntry = {
  draft: string;
  selectionStart: number;
  skillTokens: ComposerSkillToken[];
};

type RecoveryLookupRequest = {
  lookupId: number;
  scopeKey: string;
  version: number;
};

type PendingProgrammaticComposerChange = {
  expectedDraft: string;
  expectedSkillTokensSignature: string;
  staleDraft: string;
  staleSkillTokensSignature: string;
};

type ComposerImageFile = {
  file: File;
  type: string;
};

type ModelOption = NonNullable<
  NonNullable<BackendSummary["launchpadOptions"]>["models"]
>[number];

type SlashCommandSuggestion = {
  description: string;
  id: string;
  insertText: string;
  label: string;
};

type AutocompleteKind = "skills" | "slash";
type ReviewTargetChoice = AppServerReviewTarget["type"];

const CONTEXT_MOON_PHASES = [
  "new moon",
  "waxing crescent",
  "first quarter",
  "waxing gibbous",
  "full moon",
  "waning gibbous",
  "third quarter",
  "waning crescent",
  "critical",
] as const;

type ReviewConfigState = {
  branch: string;
  commit: string;
  customInstructions: string;
  target?: ReviewTargetChoice;
};

const DEFAULT_REASONING_EFFORT = "medium";

let queuedTurnIdSequence = 0;

function createQueuedTurnId(): string {
  queuedTurnIdSequence += 1;
  return `queued-turn-${Date.now().toString(36)}-${queuedTurnIdSequence.toString(36)}`;
}

const SLASH_COMMANDS: SlashCommandSuggestion[] = [
  {
    id: "review-current",
    label: "/review",
    insertText: "/review",
    description: "Review current staged, unstaged, and untracked changes",
  },
];

const REVIEW_TARGET_OPTIONS: Array<{
  description: string;
  label: string;
  target: ReviewTargetChoice;
}> = [
  {
    target: "baseBranch",
    label: "Base branch",
    description: "Compare this branch with a base branch",
  },
  {
    target: "uncommittedChanges",
    label: "Current changes",
    description: "Review staged, unstaged, and untracked files",
  },
  {
    target: "commit",
    label: "Commit",
    description: "Review one commit by SHA",
  },
  {
    target: "custom",
    label: "Custom",
    description: "Review using custom instructions",
  },
];

function getDefaultModelOption(backend?: BackendSummary): ModelOption | undefined {
  const models = backend?.launchpadOptions?.models ?? [];
  return (
    models.find((model) => model.current) ??
    models.find((model) => model.supportsReasoning) ??
    models[0]
  );
}

function getDefaultReasoningEffort(backend?: BackendSummary): string | undefined {
  const reasoningEfforts = backend?.launchpadOptions?.reasoningEfforts ?? [];
  return reasoningEfforts.includes(DEFAULT_REASONING_EFFORT)
    ? DEFAULT_REASONING_EFFORT
    : reasoningEfforts[0];
}

function getReasoningEffortValue(
  backend: BackendSummary | undefined,
  currentValue: string | undefined,
): string | undefined {
  const reasoningEfforts = backend?.launchpadOptions?.reasoningEfforts ?? [];
  return reasoningEfforts.includes(currentValue ?? "")
    ? currentValue
    : getDefaultReasoningEffort(backend);
}

function buildReviewBranchOptions(params: {
  directory?: NavigationDirectorySummary;
  thread?: NavigationThreadSummary;
}): string[] {
  const candidates = [
    "main",
    params.thread?.gitBranch,
    params.thread?.observedGitBranch,
    params.directory?.gitStatus?.currentBranch,
    params.directory?.gitStatus?.upstreamBranch?.replace(/^origin\//, ""),
    ...(params.directory?.gitStatus?.branches ?? []),
  ];
  const options = new Set<string>();
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value) {
      options.add(value);
    }
  }
  return [...options];
}

function getLaunchpadDirectoryKeyFromScope(scopeKey: string): string | undefined {
  return scopeKey.startsWith("launchpad:")
    ? scopeKey.slice("launchpad:".length)
    : undefined;
}

function createReviewConfig(params: {
  directory?: NavigationDirectorySummary;
  thread?: NavigationThreadSummary;
}): ReviewConfigState {
  return {
    branch: buildReviewBranchOptions(params)[0] ?? "main",
    commit: "",
    customInstructions: "",
  };
}

function buildConfiguredReviewCommand(
  config: ReviewConfigState | undefined
): { displayText: string; target: AppServerReviewTarget } | undefined {
  if (!config?.target) {
    return undefined;
  }

  if (config.target === "uncommittedChanges") {
    return {
      target: { type: "uncommittedChanges" },
      displayText: "Review current changes",
    };
  }

  if (config.target === "baseBranch") {
    const branch = config.branch.trim();
    return branch
      ? {
          target: { type: "baseBranch", branch },
          displayText: `Review changes against ${branch}`,
        }
      : undefined;
  }

  if (config.target === "commit") {
    const sha = config.commit.trim();
    return sha
      ? {
          target: { type: "commit", sha, title: null },
          displayText: `Review commit ${sha}`,
        }
      : undefined;
  }

  const instructions = config.customInstructions.trim();
  return instructions
    ? {
        target: { type: "custom", instructions },
        displayText: "Review custom instructions",
      }
    : undefined;
}

function findSlashCommandTrigger(text: string, caret: number): {
  end: number;
  query: string;
  start: number;
} | undefined {
  const prefix = text.slice(0, caret);
  if (/\s$/.test(prefix)) {
    return undefined;
  }
  const match = /^\/([^\r\n]*)$/.exec(prefix);
  if (!match) {
    return undefined;
  }

  return {
    start: 0,
    end: caret,
    query: match[1] ?? "",
  };
}

function formatDraftPreview(draft: QueuedTurnDraft): string {
  if (draft.reviewCommand) {
    return draft.reviewCommand.displayText;
  }

  const text = draft.text.trim();
  if (text) {
    return text;
  }

  return `${draft.imageAttachments.length} image${
    draft.imageAttachments.length === 1 ? "" : "s"
  }`;
}

function QueuedImageAttachments(props: {
  attachments: ComposerImageAttachment[];
}): ReactNode {
  if (props.attachments.length === 0) {
    return null;
  }

  const visibleAttachments = props.attachments.slice(0, 3);
  const overflowCount = props.attachments.length - visibleAttachments.length;

  return (
    <div
      className="composer__queued-images"
      aria-label={`Queued image attachments: ${props.attachments.length}`}
    >
      {visibleAttachments.map((attachment, index) => (
        <img
          className="composer__queued-image"
          key={attachment.id}
          src={attachment.url}
          alt={formatPastedImageAlt(attachment, index)}
        />
      ))}
      {overflowCount > 0 ? (
        <span className="composer__queued-image-count">
          +{overflowCount}
        </span>
      ) : null}
    </div>
  );
}

const ENV_ACTION_OUTPUT_MAX_LINES = 500;

function tailLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const dropped = lines.length - maxLines;
  return [
    `[…${dropped} earlier lines truncated]`,
    ...lines.slice(-maxLines),
  ].join("\n");
}

// Exported for unit testing; the existing call sites import via the
// in-file identifier.
export function formatDurationMs(
  ms?: number,
  options?: { coarseAfterMinute?: boolean },
): string {
  if (!ms || !Number.isFinite(ms)) return "";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  // Always integer seconds — the previous `toFixed(1)` for elapsed < 10s
  // produced "0.9s" / "1.9s" displays that kept changing the last digit
  // every render even when the second hadn't actually advanced.
  const totalSeconds = Math.round(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  // Convert via totalSeconds rather than `Math.round(seconds % 60)`,
  // which would have flipped `seconds=119.5` into `"1m 60s"` because of
  // half-up rounding at the 60-second boundary.
  const minutes = Math.floor(totalSeconds / 60);
  // For live counters (e.g., the "running for Xm" anchor meta),
  // coarseAfterMinute drops the seconds portion entirely past 1m so
  // the display only changes on minute boundaries — otherwise the
  // ticking "Xm Ys" with sub-minute updates was a distracting noise
  // floor for long-running actions like `pnpm dev`. Static one-shot
  // displays (e.g., "ran 2m 30s" on an already-exited run) leave the
  // option off and keep full precision since the value never changes
  // after first paint.
  if (options?.coarseAfterMinute) return `${minutes}m`;
  const remainder = totalSeconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

/**
 * Set of run identities the user has explicitly dismissed in this session.
 * Module-level so it survives Composer remounts (thread switches), but
 * cleared on page reload — fresh runs always show, since each run gets a
 * new runId on the server.
 */
const dismissedEnvActionAnchorKeys = new Set<string>();

/**
 * Approximate moment the renderer started this session. Runs whose latest
 * activity timestamp predates this are treated as historical (persisted
 * from a prior app launch) and not surfaced — otherwise the user would
 * have to re-dismiss the same finished run on every restart. The
 * persisted fields stay on the runtime so logs and a future "show last
 * run" affordance can still inspect them.
 */
const envActionAnchorSessionStartedAt = Date.now();

// Exported solely so the list filter + dismiss machinery can be unit-
// tested without standing up the full Composer; consumers should still
// reach the anchor through the Composer.
export function EnvActionAnchorList(props: {
  runtime?: Pick<CodexThreadEnvironmentRuntime, "actionRuns" | "environmentName"> | undefined;
}): ReactNode {
  const runs = readCodexEnvironmentActionRuns(props.runtime);
  // Tiered tick cadence for the per-run "running for X" meta:
  //   < 1 min → tick every 1s   (seconds digit moves every second;
  //                              format prints "Xs")
  //   ≥ 1 min → tick every 30s  (display switches to coarse "Xm" with
  //                              no seconds; we only need the tick to
  //                              catch each minute boundary within
  //                              ~30s, which is below user-perceived
  //                              staleness for a minute-granularity
  //                              display. Avoids the "distracting
  //                              every-5s text-change" issue.)
  // Single shared timer across all started runs on the thread; the
  // interval re-arms when the longest-running run crosses the 1-min
  // boundary.
  const tickIntervalMs = useMemo(() => {
    let maxElapsed = -1;
    for (const run of runs) {
      if (run.status !== "started") continue;
      const startedAt = run.startedAt ?? Date.now();
      const elapsed = Date.now() - startedAt;
      if (elapsed > maxElapsed) maxElapsed = elapsed;
    }
    if (maxElapsed < 0) return 0; // no running runs → no timer
    if (maxElapsed < 60_000) return 1_000;
    return 30_000;
  }, [runs]);
  const [, setElapsedTick] = useState(0);
  useEffect(() => {
    if (!tickIntervalMs) return undefined;
    const handle = setInterval(() => {
      setElapsedTick((tick) => tick + 1);
    }, tickIntervalMs);
    return () => clearInterval(handle);
  }, [tickIntervalMs]);
  // Bumped after dismissal to force a re-render (the dismissed-set lives
  // outside React state).
  const [, setDismissTick] = useState(0);

  const visible = runs.filter((run) => {
    if (dismissedEnvActionAnchorKeys.has(run.runId)) return false;
    const latestActivityAt = Math.max(run.exitedAt ?? 0, run.startedAt ?? 0);
    // Anything not started during this renderer session is treated as
    // historical / zombie and hidden. Note: the `< envActionAnchorSessionStartedAt`
    // check catches runs with timestamps that predate this session AND
    // runs with missing/zero timestamps (legacy overlay rows from before
    // actionStartedAt existed synthesise startedAt=0 via
    // readCodexEnvironmentActionRuns). The earlier `latestActivityAt > 0`
    // guard let those legacy entries slip through, leaving the user with
    // an undismissable "running" zombie after an app crash — see the
    // PwrAgent termination repro in PR #505 review.
    if (latestActivityAt < envActionAnchorSessionStartedAt) {
      return false;
    }
    return true;
  });
  if (visible.length === 0) return null;

  return (
    <>
      {visible.map((run) => (
        <EnvActionAnchorEntry
          key={run.runId}
          run={run}
          environmentName={props.runtime?.environmentName}
          onDismiss={() => {
            dismissedEnvActionAnchorKeys.add(run.runId);
            setDismissTick((tick) => tick + 1);
          }}
        />
      ))}
    </>
  );
}

// Exported solely so the entry can be unit-tested without standing up the
// full Composer; consumers should still go through EnvActionAnchorList.
export function EnvActionAnchorEntry(props: {
  run: CodexEnvironmentActionRun;
  environmentName: string | undefined;
  onDismiss: () => void;
}): ReactNode {
  const { run } = props;
  const status = run.status;
  const label =
    status === "started"
      ? "Env action running"
      : status === "exited"
        ? "Env action exited"
        : "Env action failed";

  const meta: string[] = [];
  if (run.pid) meta.push(`pid ${run.pid}`);
  if (status === "started" && run.startedAt) {
    meta.push(
      `running for ${formatDurationMs(Date.now() - run.startedAt, { coarseAfterMinute: true })}`,
    );
  }
  if (status !== "started") {
    if (typeof run.exitCode === "number") {
      meta.push(`exit ${run.exitCode}`);
    } else if (run.exitSignal) {
      meta.push(`signal ${run.exitSignal}`);
    }
    if (run.durationMs) {
      meta.push(`ran ${formatDurationMs(run.durationMs)}`);
    }
  }

  const truncatedOutput = tailLines((run.output ?? "").trim(), ENV_ACTION_OUTPUT_MAX_LINES);
  const modifier =
    status === "failed"
      ? "composer__queued--env-action-failed"
      : status === "exited"
        ? "composer__queued--env-action-exited"
        : "composer__queued--env-action-running";

  return (
    <details
      className={`composer__queued composer__queued--env-action ${modifier}`}
      aria-label={label}
    >
      <summary className="composer__queued-env-action-summary">
        <span
          className="composer__queued-env-action-chevron"
          aria-hidden="true"
        />
        <span className="composer__queued-env-action-summary-text">
          <span className="composer__queued-label">{label}</span>
          <span className="composer__queued-text">
            {run.actionName}
            {props.environmentName ? ` · ${props.environmentName}` : ""}
            {meta.length > 0 ? ` · ${meta.join(" · ")}` : ""}
          </span>
        </span>
        <button
          className="composer__secondary-action composer__queued-env-action-dismiss"
          type="button"
          onClick={(event) => {
            // Prevent the click from toggling the surrounding <details>.
            event.preventDefault();
            event.stopPropagation();
            props.onDismiss();
          }}
        >
          Dismiss
        </button>
      </summary>
      <div className="composer__queued-env-action-body">
        {run.command ? (
          <div className="composer__queued-env-action-section">
            <div className="composer__queued-env-action-section-label">
              Command
            </div>
            <pre className="composer__queued-env-action-command-block">
              <code>$ {run.command}</code>
            </pre>
          </div>
        ) : null}
        <div className="composer__queued-env-action-section">
          <div className="composer__queued-env-action-section-label">
            Output
            {truncatedOutput
              ? ` · ${truncatedOutput.split("\n").length} line${
                  truncatedOutput.split("\n").length === 1 ? "" : "s"
                }`
              : ""}
          </div>
          <pre className="composer__queued-env-action-output">
            <code>
              {truncatedOutput ||
                (status === "started"
                  ? "(no output yet — waiting for the command to print something)"
                  : "(no output captured)")}
            </code>
          </pre>
        </div>
      </div>
    </details>
  );
}

function collectTextFragments(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectTextFragments(entry));
  }

  const record = value as Record<string, unknown>;
  const directText = ["text", "content", "message", "input"].flatMap((key) =>
    typeof record[key] === "string" ? [record[key] as string] : []
  );
  const nestedText = ["content", "parts", "input", "item"].flatMap((key) =>
    typeof record[key] === "string" ? [] : collectTextFragments(record[key])
  );
  return [...directText, ...nestedText];
}

function notificationIncludesDraftText(params: unknown, draft: QueuedTurnDraft): boolean {
  const preview = draft.text.trim();
  if (!preview) {
    return false;
  }

  return collectTextFragments(params).some((fragment) =>
    fragment.includes(preview)
  );
}

function isSteerInjectionOpportunity(method: string): boolean {
  return method === "item/completed" || method === "exec_command/ended";
}

function parseStaleSteerError(
  error: unknown
): { activeTurnId?: string; active: boolean } | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes("no active turn to steer")) {
    return { active: false };
  }

  const activeTurnMatch = message.match(/found `([^`]+)`/);
  if (
    normalized.includes("expected active turn id") &&
    activeTurnMatch?.[1]
  ) {
    return {
      active: true,
      activeTurnId: activeTurnMatch[1],
    };
  }

  return undefined;
}

function reviewCommandToDraftText(command: {
  target: AppServerReviewTarget;
}): string {
  const target = command.target;
  if (target.type === "uncommittedChanges") {
    return "/review";
  }
  if (target.type === "baseBranch") {
    return `/review ${target.branch}`;
  }
  if (target.type === "commit") {
    return `/review --commit ${[target.sha, target.title].filter(Boolean).join(" ")}`;
  }
  return `/review --custom ${target.instructions}`;
}

function HighlightedAutocompleteLabel(props: {
  label: string;
  query: string;
}) {
  if (!props.query || !props.label.toLowerCase().startsWith(props.query.toLowerCase())) {
    return <span>{props.label}</span>;
  }

  return (
    <span>
      <span className="composer__autocomplete-match">
        {props.label.slice(0, props.query.length)}
      </span>
      {props.label.slice(props.query.length)}
    </span>
  );
}

function createComposerSkillToken(
  skill: AppServerSkillSummary,
  index: number,
): ComposerSkillToken {
  return {
    ...skill,
    id: `${skill.path ?? skill.name}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    index,
  };
}

function getComposerSkillTokensSignature(skillTokens: ComposerSkillToken[]): string {
  return JSON.stringify(
    skillTokens.map((token) => ({
      id: token.id,
      index: token.index,
      name: token.name,
      path: token.path,
    })),
  );
}

function clampSkillTokenIndex(index: number, draft: string): number {
  return Math.max(0, Math.min(index, draft.length));
}

function serializeDraftWithSkillTokens(
  draft: string,
  skillTokens: ComposerSkillToken[],
): string {
  if (skillTokens.length === 0) {
    return draft;
  }

  const sortedTokens = [...skillTokens].sort((left, right) => {
    if (left.index !== right.index) {
      return left.index - right.index;
    }
    return left.id.localeCompare(right.id);
  });

  let output = "";
  let cursor = 0;
  for (const token of sortedTokens) {
    const index = clampSkillTokenIndex(token.index, draft);
    output += draft.slice(cursor, index);
    output += buildSkillMentionMarkdown(token);
    cursor = index;
  }

  output += draft.slice(cursor);
  return output;
}

function hydrateComposerDraft(
  canonicalDraft: string,
  skills: AppServerSkillSummary[],
): {
  draft: string;
  skillTokens: ComposerSkillToken[];
} {
  let draft = "";
  const skillTokens: ComposerSkillToken[] = [];

  for (const part of parseSkillMentionParts(canonicalDraft)) {
    if (part.type === "text") {
      draft += part.text;
      continue;
    }

    const matchingSkill =
      skills.find((skill) => skill.path === part.path) ??
      skills.find((skill) => skill.name === part.name);
    skillTokens.push(
      createComposerSkillToken(
        matchingSkill ?? {
          name: part.name,
          path: part.path,
        },
        draft.length,
      ),
    );
  }

  return { draft, skillTokens };
}

function adjustSkillTokenIndexesForTextChange(params: {
  currentDraft: string;
  nextDraft: string;
  skillTokens: ComposerSkillToken[];
}): ComposerSkillToken[] {
  const { currentDraft, nextDraft, skillTokens } = params;
  if (currentDraft === nextDraft || skillTokens.length === 0) {
    return skillTokens;
  }

  let prefixLength = 0;
  while (
    prefixLength < currentDraft.length &&
    prefixLength < nextDraft.length &&
    currentDraft[prefixLength] === nextDraft[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < currentDraft.length - prefixLength &&
    suffixLength < nextDraft.length - prefixLength &&
    currentDraft[currentDraft.length - 1 - suffixLength] ===
      nextDraft[nextDraft.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const currentChangedEnd = currentDraft.length - suffixLength;
  const nextChangedEnd = nextDraft.length - suffixLength;
  const delta = nextChangedEnd - currentChangedEnd;

  return skillTokens.map((token) => {
    if (token.index <= prefixLength) {
      return token;
    }

    if (token.index >= currentChangedEnd) {
      return {
        ...token,
        index: clampSkillTokenIndex(token.index + delta, nextDraft),
      };
    }

    return {
      ...token,
      index: clampSkillTokenIndex(prefixLength, nextDraft),
    };
  });
}

function rankSkillAutocompleteMatch(
  skill: AppServerSkillSummary,
  normalizedQuery: string,
): number | undefined {
  if (!normalizedQuery) {
    return 0;
  }

  const name = skill.name.toLowerCase();
  const shortDescription = skill.shortDescription?.toLowerCase() ?? "";
  const description = skill.description?.toLowerCase() ?? "";

  if (name === normalizedQuery) {
    return 0;
  }
  if (name.startsWith(`${normalizedQuery}:`)) {
    return 1;
  }
  if (name.startsWith(normalizedQuery)) {
    return 2;
  }
  if (name.includes(normalizedQuery)) {
    return 3;
  }
  if (shortDescription.includes(normalizedQuery)) {
    return 4;
  }
  if (description.includes(normalizedQuery)) {
    return 5;
  }

  return undefined;
}

function useDismissableMenu<T extends HTMLElement>(
  open: boolean,
  onDismiss: () => void,
) {
  const ref = useRef<T>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: PointerEvent): void => {
      if (!ref.current?.contains(event.target as Node)) {
        onDismiss();
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onDismiss();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onDismiss, open]);

  return ref;
}

function ComposerDropdown(props: {
  ariaLabel: string;
  compact?: boolean;
  disabled?: boolean;
  icon?: ComposerDropdownIcon;
  id?: string;
  kind?: "branch";
  onChange: (value: string) => void;
  options: ComposerDropdownOption[];
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const listboxId = useId();
  const selectedOption =
    props.options.find((option) => option.value === props.value) ?? props.options[0];
  const ref = useDismissableMenu<HTMLDivElement>(open, () => setOpen(false));
  const Icon = props.icon;

  return (
    <div
      className={[
        "composer-dropdown",
        props.compact ? "composer-dropdown--compact" : "",
        props.kind === "branch" ? "composer-dropdown--branch" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      ref={ref}
    >
      <button
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={props.ariaLabel}
        className="composer-dropdown__button"
        data-value={props.value}
        disabled={props.disabled || props.options.length === 0}
        id={props.id}
        type="button"
        value={props.value}
        onClick={() => setOpen((current) => !current)}
      >
        {Icon ? (
          <span aria-hidden="true" className="composer-dropdown__icon">
            <Icon size={13} />
          </span>
        ) : null}
        <span className="composer-dropdown__label">
          {selectedOption?.label ?? props.value}
        </span>
        <span aria-hidden="true" className="composer-dropdown__chevron">
          ⌄
        </span>
      </button>
      {open ? (
        <div className="composer-dropdown__menu" id={listboxId} role="listbox">
          {props.options.map((option) => (
            <button
              aria-selected={option.value === props.value}
              className="composer-dropdown__option"
              disabled={option.disabled}
              key={option.value}
              role="option"
              type="button"
              onClick={() => {
                setOpen(false);
                if (option.value !== props.value) {
                  props.onChange(option.value);
                }
              }}
            >
              {option.value === props.value ? (
                <span aria-hidden="true" className="composer-dropdown__check">
                  ✓
                </span>
              ) : (
                <span aria-hidden="true" className="composer-dropdown__check" />
              )}
              <span className="composer-dropdown__option-label">{option.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ComposerApplicationButton(props: {
  application: DesktopApplicationDiscoveryCandidate;
  label: string;
  onOpen: (application: DesktopApplicationDiscoveryCandidate) => Promise<void>;
}) {
  return (
    <button
      className="composer__application-button"
      title={`Open workspace in ${props.application.name}`}
      type="button"
      onClick={() => {
        void props.onOpen(props.application);
      }}
    >
      {props.application.iconDataUrl ? (
        <img
          alt=""
          className="composer__application-icon"
          src={props.application.iconDataUrl}
        />
      ) : props.application.kind === "editor" ? (
        <span
          aria-hidden="true"
          className="composer__application-icon composer__application-icon--glyph"
        >
          <EditorIcon size={14} />
        </span>
      ) : props.application.kind === "terminal" ? (
        <span
          aria-hidden="true"
          className="composer__application-icon composer__application-icon--glyph"
        >
          <TerminalIcon size={14} />
        </span>
      ) : (
        <span
          aria-hidden="true"
          className="composer__application-icon composer__application-icon--fallback"
        >
          {props.application.name.slice(0, 1)}
        </span>
      )}
      <span>{props.label}</span>
    </button>
  );
}

function CopyableComposerError(props: {
  desktopApi?: Pick<DesktopApi, "copyText">;
  label: string;
  text: string;
}) {
  return (
    <div className="composer__meta composer__meta--error composer__meta--copyable">
      <span className="composer__meta-text">{props.text}</span>
      <TranscriptCopyButton
        className="transcript-copy-button--composer-error"
        copiedLabel="Copied error"
        desktopApi={props.desktopApi}
        label={props.label}
        text={props.text}
      />
    </div>
  );
}

export function Composer(props: ComposerProps) {
  const inputRef = useRef<ComposerInputHandle>(null);
  const inputWrapRef = useRef<HTMLDivElement>(null);
  const autocompleteListRef = useRef<HTMLDivElement>(null);
  const activeTurnIdRef = useRef<string | undefined>(props.activeTurnId);
  const autocompleteOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const skillListboxId = useId();
  const slashListboxId = useId();
  const hydratedLaunchpadKeyRef = useRef<string | undefined>(undefined);
  const pendingProgrammaticComposerChangeRef =
    useRef<PendingProgrammaticComposerChange | undefined>(undefined);
  const composerScopeKey = props.launchpad
    ? `launchpad:${props.launchpad.directoryKey}`
    : props.thread
      ? `thread:${props.thread.source}:${props.thread.id}`
      : "empty";
  const localDraftStore = useComposerDraftStore();
  const draftStore = props.draftStore ?? localDraftStore;
  const draftStoreHydrationVersion = draftStore.hydrationVersion ?? 0;
  const savedInitialDraft = draftStore.get(composerScopeKey);
  const savedInitialQueuedTurns = props.thread
    ? draftStore.getQueuedTurns(composerScopeKey)
    : undefined;
  const savedInitialPendingSteer = props.thread
    ? draftStore.getPendingSteer(composerScopeKey)
    : undefined;
  const hydratedInitialLaunchpad =
    savedInitialDraft || !props.launchpad
      ? undefined
      : hydrateComposerDraft(props.launchpad.prompt ?? "", props.skills);
  const activeComposerScopeKeyRef = useRef(composerScopeKey);
  const pasteScopeRef = useRef({ key: composerScopeKey, version: 0 });
  const submittedDraftScopeKeysRef = useRef<Set<string>>(new Set());
  const recoveryCycleRef = useRef<{
    activeIndex?: number;
    candidates: ComposerDraftSnapshot[];
    scopeKey: string;
  } | undefined>(undefined);
  const recoveryEligibilityVersionRef = useRef(0);
  const recoveryLookupSequenceRef = useRef(0);
  const recoveringDraftRef = useRef(false);
  const composerSelectionRequestSequenceRef = useRef(0);
  const deletedSkillTokenHistoryRef = useRef<DeletedSkillTokenHistoryEntry[]>([]);
  const latestDraftSnapshotRef = useRef<{
    scopeKey: string;
    snapshot: ComposerDraftSnapshot;
  }>({
    scopeKey: composerScopeKey,
    snapshot: {
      draft: savedInitialDraft?.draft ?? hydratedInitialLaunchpad?.draft ?? "",
      editorDocument:
        savedInitialDraft?.editorDocument ??
        (props.launchpad?.editorDocument as JSONContent | undefined),
      imageAttachments:
        savedInitialDraft?.imageAttachments ??
        props.launchpad?.imageAttachments ??
        [],
      skillTokens:
        savedInitialDraft?.skillTokens ?? hydratedInitialLaunchpad?.skillTokens ?? [],
    },
  });
  const launchpadUpdateRef = useRef(props.onUpdateLaunchpad);
  const [draft, setDraft] = useState(
    latestDraftSnapshotRef.current.snapshot.draft
  );
  const [editorDocument, setEditorDocument] = useState(
    latestDraftSnapshotRef.current.snapshot.editorDocument
  );
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const workspaceMenuRef = useDismissableMenu<HTMLDivElement>(
    workspaceMenuOpen,
    () => setWorkspaceMenuOpen(false),
  );
  const [handoffDialog, setHandoffDialog] = useState<
    HandoffThreadWorkspaceRequest["direction"] | undefined
  >();
  const [localHandoffStrategy, setLocalHandoffStrategy] =
    useState<LocalHandoffStrategy>("detached-changes");
  const [leaveLocalBranch, setLeaveLocalBranch] = useState("");
  const [newLocalBranch, setNewLocalBranch] = useState("");
  const [handoffError, setHandoffError] = useState<string | undefined>();
  const [handoffSubmitting, setHandoffSubmitting] = useState(false);
  const [sending, setSendingState] = useState(false);
  const sendingRef = useRef(false);
  const updateSending = (nextSending: boolean): void => {
    sendingRef.current = nextSending;
    setSendingState(nextSending);
  };
  const [interrupting, setInterrupting] = useState(false);
  const [steering, setSteering] = useState(false);
  const [queuedTurns, setQueuedTurnsState] = useState<QueuedTurnDraft[]>(
    savedInitialQueuedTurns ?? []
  );
  const queuedAutoReleaseAttemptIdRef = useRef<string | undefined>(undefined);
  const [pendingSteer, setPendingSteerState] = useState<
    PendingSteerDraft | undefined
  >(
    savedInitialPendingSteer
      ? { ...savedInitialPendingSteer, status: "pending" }
      : undefined
  );
  const [activeTurnId, setActiveTurnId] = useState<string | undefined>(
    props.activeTurnId
  );
  const [sendError, setSendError] = useState<string>();
  const [applicationOpenError, setApplicationOpenError] = useState<string>();
  const [imageAttachments, setImageAttachments] = useState<ComposerImageAttachment[]>(
    latestDraftSnapshotRef.current.snapshot.imageAttachments
  );
  const [planModeEnabled, setPlanModeEnabled] = useState(false);
  const [skillTokens, setSkillTokens] = useState<ComposerSkillToken[]>(
    latestDraftSnapshotRef.current.snapshot.skillTokens
  );
  const [composerSelectionRequest, setComposerSelectionRequest] = useState<{
    id: string;
    index: number;
  }>();
  const [activeSkillIndex, setActiveSkillIndex] = useState(0);
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const [dismissedAutocompleteKey, setDismissedAutocompleteKey] = useState<string>();
  const [fullAccessRiskDialogOpen, setFullAccessRiskDialogOpen] =
    useState(false);
  const [fullAccessRiskDontWarnAgain, setFullAccessRiskDontWarnAgain] =
    useState(false);
  const [fullAccessRiskSaving, setFullAccessRiskSaving] = useState(false);
  const [fullAccessRiskError, setFullAccessRiskError] = useState<string>();
  const [autocompleteLayout, setAutocompleteLayout] = useState<{
    maxHeight: number;
    placement: "above" | "below";
  }>({ maxHeight: 320, placement: "above" });
  const [activeOptimisticMessageId, setActiveOptimisticMessageId] = useState<string>();
  const [reviewConfig, setReviewConfig] = useState<ReviewConfigState>();
  const isLaunchpad = Boolean(props.launchpad && props.directory);
  const launchpad = props.launchpad;
  const backend = useMemo(
    () =>
      props.backends?.find((candidate) =>
        candidate.kind === (props.launchpad?.backend ?? props.thread?.source)
      ),
    [props.backends, props.launchpad?.backend, props.thread?.source]
  );

  const selectionStart = Math.min(
    inputRef.current?.selectionStart ?? draft.length,
    draft.length,
  );
  const isDraftStoreScope = (scopeKey: string): boolean =>
    scopeKey === "empty" ||
    scopeKey.startsWith("thread:") ||
    scopeKey.startsWith("launchpad:");
  const canonicalDraft = useMemo(
    () => serializeDraftWithSkillTokens(draft, skillTokens),
    [draft, skillTokens]
  );
  const hasComposerContent =
    draft.trim().length > 0 || skillTokens.length > 0;
  const queuedTurn = queuedTurns[0];
  launchpadUpdateRef.current = props.onUpdateLaunchpad;
  latestDraftSnapshotRef.current = {
    scopeKey: composerScopeKey,
    snapshot: {
      draft,
      editorDocument,
      imageAttachments,
      skillTokens,
    },
  };
  const setComposerDraftFromCanonical = (nextDraft: string): void => {
    deletedSkillTokenHistoryRef.current = [];
    setEditorDocument(undefined);
    const hydrated = hydrateComposerDraft(nextDraft, props.skills);
    setDraft(hydrated.draft);
    setSkillTokens(hydrated.skillTokens);
  };
  const clearComposerDraft = (): void => {
    deletedSkillTokenHistoryRef.current = [];
    setEditorDocument(undefined);
    setDraft("");
    setSkillTokens([]);
  };
  const hasLiveComposerContent = (): boolean => {
    const latest = latestDraftSnapshotRef.current;
    return Boolean(
      (inputRef.current?.value ?? latest.snapshot.draft).trim() ||
        (inputRef.current?.skillTokenCount ??
          latest.snapshot.skillTokens.length) > 0 ||
        latest.snapshot.imageAttachments.length > 0,
    );
  };
  const updateVisibleDraft = (
    nextDraft: string,
    nextSkillTokens?: ComposerSkillToken[],
    options?: { preserveRecoveryCycle?: boolean },
  ): void => {
    if (!recoveringDraftRef.current && !options?.preserveRecoveryCycle) {
      recoveryCycleRef.current = undefined;
    }
    deletedSkillTokenHistoryRef.current = [];
    setEditorDocument(undefined);
    if (nextSkillTokens) {
      setSkillTokens(nextSkillTokens);
    } else {
      setSkillTokens((current) =>
        adjustSkillTokenIndexesForTextChange({
          currentDraft: draft,
          nextDraft,
          skillTokens: current,
        })
      );
    }
    setDraft(nextDraft);
  };
  const saveComposerDraftSnapshot = (
    scopeKey: string,
    state: ComposerDraftSnapshot,
  ): void => {
    if (!isDraftStoreScope(scopeKey)) {
      return;
    }

    if (
      !state.draft.trim() &&
      state.skillTokens.length === 0 &&
      state.imageAttachments.length === 0
    ) {
      const previous = latestDraftSnapshotRef.current;
      if (
        previous.scopeKey === scopeKey &&
        (previous.snapshot.draft.trim() ||
          previous.snapshot.skillTokens.length > 0 ||
          previous.snapshot.imageAttachments.length > 0)
      ) {
        recordComposerDraftHistory(scopeKey, previous.snapshot, "abandoned");
      }
      draftStore.delete(scopeKey);
      return;
    }

    draftStore.set(scopeKey, state);
  };
  const clearComposerDraftSnapshot = (scopeKey: string): void => {
    if (isDraftStoreScope(scopeKey)) {
      draftStore.delete(scopeKey);
    }
  };
  const recordComposerDraftHistory = (
    scopeKey: string,
    state: ComposerDraftSnapshot,
    status: "unsent" | "sent" | "abandoned",
  ): void => {
    if (!isDraftStoreScope(scopeKey)) {
      return;
    }
    draftStore.recordHistory?.(scopeKey, state, status);
  };
  const getComposerDraftSnapshotSignature = (
    snapshot: ComposerDraftSnapshot,
  ): string =>
    JSON.stringify({
      draft: snapshot.draft,
      editorDocument: snapshot.editorDocument,
      imageAttachments: snapshot.imageAttachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        size: attachment.size,
        type: attachment.type,
        url: attachment.url,
      })),
      skillTokens: snapshot.skillTokens.map((token) => ({
        index: token.index,
        name: token.name,
        path: token.path,
      })),
    });
  const dedupeComposerDraftSnapshots = (
    snapshots: ComposerDraftSnapshot[],
  ): ComposerDraftSnapshot[] => {
    const seen = new Set<string>();
    return snapshots.filter((snapshot) => {
      const signature = getComposerDraftSnapshotSignature(snapshot);
      if (seen.has(signature)) {
        return false;
      }
      seen.add(signature);
      return true;
    });
  };
  const applyRecoveredComposerDraft = (
    snapshot: ComposerDraftSnapshot,
  ): void => {
    recoveringDraftRef.current = true;
    deletedSkillTokenHistoryRef.current = [];
    flushSync(() => {
      setDraft(snapshot.draft);
      setEditorDocument(snapshot.editorDocument);
      setImageAttachments(snapshot.imageAttachments);
      setSkillTokens(snapshot.skillTokens);
      setComposerSelectionRequest({
        id: `recovery:${++composerSelectionRequestSequenceRef.current}`,
        index: 0,
      });
    });
    saveComposerDraftSnapshot(composerScopeKey, snapshot);
    setSendError(undefined);
    requestAnimationFrame(() => {
      recoveringDraftRef.current = false;
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(0, 0);
      requestAnimationFrame(() => {
        inputRef.current?.setSelectionRange(0, 0);
      });
    });
  };
  const clearRecoveredComposerDraft = (): void => {
    recoveryCycleRef.current = undefined;
    recoveringDraftRef.current = true;
    deletedSkillTokenHistoryRef.current = [];
    clearComposerDraftSnapshot(composerScopeKey);
    flushSync(() => {
      setDraft("");
      setEditorDocument(undefined);
      setImageAttachments([]);
      setSkillTokens([]);
      setComposerSelectionRequest({
        id: `recovery:${++composerSelectionRequestSequenceRef.current}`,
        index: 0,
      });
    });
    setSendError(undefined);
    requestAnimationFrame(() => {
      recoveringDraftRef.current = false;
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(0, 0);
      requestAnimationFrame(() => {
        inputRef.current?.setSelectionRange(0, 0);
      });
    });
  };
  const isRecoveryLookupCurrent = (
    request: RecoveryLookupRequest,
  ): boolean =>
    recoveryLookupSequenceRef.current === request.lookupId &&
    recoveryEligibilityVersionRef.current === request.version &&
    activeComposerScopeKeyRef.current === request.scopeKey &&
    latestDraftSnapshotRef.current.scopeKey === request.scopeKey &&
    !hasLiveComposerContent();
  const getOrCreateRecoveryCycle = async (
    request?: RecoveryLookupRequest,
  ): Promise<
    NonNullable<typeof recoveryCycleRef.current> | undefined
  > => {
    if (!draftStore.listRecoveryCandidates) {
      return undefined;
    }

    let cycle = recoveryCycleRef.current;
    if (!cycle || cycle.scopeKey !== composerScopeKey) {
      let response = await draftStore
        .listRecoveryCandidates({
          backend: props.thread?.source,
          directoryKey: props.launchpad?.directoryKey ?? props.directory?.key,
          includeSent: true,
          limit: 20,
          scopeKey: composerScopeKey,
          threadId: props.thread?.id,
        })
        .catch((error) => {
          console.warn("Failed to list composer draft recovery candidates", error);
          return [];
        });
      if (response.length === 0) {
        response = await draftStore
          .listRecoveryCandidates({
            includeSent: true,
            limit: 20,
          })
          .catch((error) => {
            console.warn(
              "Failed to list global composer draft recovery candidates",
              error,
            );
            return [];
          });
      }
      if (request && !isRecoveryLookupCurrent(request)) {
        return undefined;
      }
      const candidates = response
        .map((candidate) => ({
          draft: candidate.text,
          editorDocument: candidate.editorDocument as JSONContent | undefined,
          imageAttachments: candidate.imageAttachments,
          skillTokens: candidate.skillTokens as ComposerSkillToken[],
        }))
        .filter(
          (candidate) =>
            candidate.draft.trim() ||
            candidate.skillTokens.length > 0 ||
            candidate.imageAttachments.length > 0,
        );
      const uniqueCandidates = dedupeComposerDraftSnapshots(candidates);
      if (uniqueCandidates.length === 0) {
        return;
      }
      cycle = {
        activeIndex: undefined,
        candidates: uniqueCandidates,
        scopeKey: composerScopeKey,
      };
    }

    return cycle;
  };
  const recoverPreviousComposerDraft = async (): Promise<void> => {
    const existingCycle = recoveryCycleRef.current;
    const lookupRequest =
      !existingCycle || existingCycle.scopeKey !== composerScopeKey
        ? {
            lookupId: ++recoveryLookupSequenceRef.current,
            scopeKey: composerScopeKey,
            version: recoveryEligibilityVersionRef.current,
          }
        : undefined;
    const cycle = await getOrCreateRecoveryCycle(lookupRequest);
    if (!cycle) {
      return;
    }
    if (lookupRequest && !isRecoveryLookupCurrent(lookupRequest)) {
      return;
    }

    const activeIndex = cycle.activeIndex ?? -1;
    const nextIndex = Math.min(activeIndex + 1, cycle.candidates.length - 1);
    const candidate = cycle.candidates[nextIndex];
    recoveryCycleRef.current = {
      ...cycle,
      activeIndex: nextIndex,
    };
    applyRecoveredComposerDraft(candidate);
  };
  const recoverNextComposerDraft = (): void => {
    const cycle = recoveryCycleRef.current;
    if (!cycle || cycle.scopeKey !== composerScopeKey) {
      return;
    }

    const activeIndex = cycle.activeIndex ?? 0;
    const nextIndex = activeIndex - 1;
    if (nextIndex < 0) {
      clearRecoveredComposerDraft();
      return;
    }

    recoveryCycleRef.current = {
      ...cycle,
      activeIndex: nextIndex,
    };
    applyRecoveredComposerDraft(cycle.candidates[nextIndex]);
  };
  const isQueuedTurnStoreScope = (scopeKey: string): boolean =>
    scopeKey.startsWith("thread:");
  const savePendingSteerSnapshot = (
    scopeKey: string,
    state?: ComposerPendingSteerSnapshot,
  ): void => {
    if (!isQueuedTurnStoreScope(scopeKey)) {
      return;
    }

    if (!state || (!state.text.trim() && state.imageAttachments.length === 0)) {
      draftStore.deletePendingSteer(scopeKey);
      return;
    }

    draftStore.setPendingSteer(scopeKey, state);
  };
  const saveQueuedTurnSnapshots = (
    scopeKey: string,
    state: ComposerQueuedTurnSnapshot[],
  ): void => {
    if (!isQueuedTurnStoreScope(scopeKey)) {
      return;
    }

    const snapshots = state.filter(
      (entry) =>
        entry.reviewCommand ||
        entry.text.trim() ||
        entry.imageAttachments.length > 0 ||
        entry.input?.length,
    );

    if (snapshots.length === 0) {
      draftStore.deleteQueuedTurn(scopeKey);
      return;
    }

    draftStore.setQueuedTurns(scopeKey, snapshots);
  };
  const setQueuedTurns = (nextQueuedTurns: QueuedTurnDraft[]): void => {
    saveQueuedTurnSnapshots(composerScopeKey, nextQueuedTurns);
    setQueuedTurnsState(nextQueuedTurns);
  };
  const setQueuedTurn = (nextQueuedTurn?: QueuedTurnDraft): void => {
    setQueuedTurns(nextQueuedTurn ? [nextQueuedTurn] : []);
  };
  const enqueueQueuedTurn = (nextQueuedTurn: QueuedTurnDraft): void => {
    setQueuedTurnsState((current) => {
      const nextQueuedTurns = [...current, nextQueuedTurn];
      saveQueuedTurnSnapshots(composerScopeKey, nextQueuedTurns);
      return nextQueuedTurns;
    });
  };
  const removeQueuedTurnAt = (index: number): void => {
    setQueuedTurnsState((current) => {
      const nextQueuedTurns = current.filter((_, candidateIndex) => {
        return candidateIndex !== index;
      });
      saveQueuedTurnSnapshots(composerScopeKey, nextQueuedTurns);
      return nextQueuedTurns;
    });
  };
  const removeQueuedTurn = (queued: QueuedTurnDraft): void => {
    setQueuedTurnsState((current) => {
      const nextQueuedTurns = current.filter((candidate) => {
        return candidate.id !== queued.id;
      });
      if (nextQueuedTurns.length === current.length) {
        return current;
      }
      saveQueuedTurnSnapshots(composerScopeKey, nextQueuedTurns);
      return nextQueuedTurns;
    });
  };
  const removeLocalQueuedTurn = (queued: QueuedTurnDraft): void => {
    setQueuedTurnsState((current) =>
      current.filter((candidate) => candidate.id !== queued.id)
    );
  };
  const claimQueuedTurn = (queued: QueuedTurnDraft): QueuedTurnDraft | undefined => {
    if (!isQueuedTurnStoreScope(composerScopeKey)) {
      return queued;
    }

    const claimed = draftStore.removeQueuedTurnById(composerScopeKey, queued.id);
    if (!claimed) {
      removeLocalQueuedTurn(queued);
      return undefined;
    }

    removeLocalQueuedTurn(queued);
    return claimed as QueuedTurnDraft;
  };
  const restoreClaimedQueuedTurn = (queued: QueuedTurnDraft): void => {
    setQueuedTurnsState((current) => {
      if (current.some((candidate) => candidate.id === queued.id)) {
        return current;
      }

      const nextQueuedTurns = [queued, ...current];
      saveQueuedTurnSnapshots(composerScopeKey, nextQueuedTurns);
      return nextQueuedTurns;
    });
  };
  const restoreQueuedTurnIfClaimed = (
    queued: QueuedTurnDraft | undefined,
    queueClaimed: boolean | undefined,
  ): void => {
    if (queued && queueClaimed) {
      restoreClaimedQueuedTurn(queued);
    }
  };
  const setPendingSteer = (nextPendingSteer?: PendingSteerDraft): void => {
    if (nextPendingSteer?.status === "pending") {
      savePendingSteerSnapshot(composerScopeKey, nextPendingSteer);
    } else {
      savePendingSteerSnapshot(composerScopeKey);
    }
    setPendingSteerState(nextPendingSteer);
  };
  const updatePendingSteer = (
    updater: (current?: PendingSteerDraft) => PendingSteerDraft | undefined,
  ): void => {
    setPendingSteerState((current) => {
      const nextPendingSteer = updater(current);
      if (nextPendingSteer?.status === "pending") {
        savePendingSteerSnapshot(composerScopeKey, nextPendingSteer);
      } else {
        savePendingSteerSnapshot(composerScopeKey);
      }
      return nextPendingSteer;
    });
  };
  const markComposerDraftSubmitted = (scopeKey: string): void => {
    if (!isDraftStoreScope(scopeKey)) {
      return;
    }

    submittedDraftScopeKeysRef.current.add(scopeKey);
    clearComposerDraftSnapshot(scopeKey);
  };
  const unmarkComposerDraftSubmitted = (scopeKey: string): void => {
    submittedDraftScopeKeysRef.current.delete(scopeKey);
  };
  const clearSubmittedComposerDraft = (scopeKey: string): void => {
    const emptySnapshot: ComposerDraftSnapshot = {
      draft: "",
      editorDocument: undefined,
      imageAttachments: [],
      skillTokens: [],
    };

    const latest = latestDraftSnapshotRef.current;
    if (latest.scopeKey === scopeKey) {
      recordComposerDraftHistory(scopeKey, latest.snapshot, "sent");
    }
    clearComposerDraftSnapshot(scopeKey);
    latestDraftSnapshotRef.current = {
      scopeKey,
      snapshot: emptySnapshot,
    };
    clearComposerDraft();
    setImageAttachments([]);
  };
  const persistLaunchpadDraftSnapshot = (
    scopeKey: string,
    snapshot: ComposerDraftSnapshot,
  ): void => {
    const directoryKey = getLaunchpadDirectoryKeyFromScope(scopeKey);
    const updateLaunchpad = launchpadUpdateRef.current;
    if (!directoryKey || !updateLaunchpad) {
      return;
    }

    void updateLaunchpad(directoryKey, {
      imageAttachments:
        snapshot.imageAttachments.length > 0 ? snapshot.imageAttachments : undefined,
      prompt: serializeDraftWithSkillTokens(snapshot.draft, snapshot.skillTokens),
    });
  };
  const flushComposerDraftSnapshot = (
    scopeKey: string,
    snapshot: ComposerDraftSnapshot,
  ): void => {
    if (submittedDraftScopeKeysRef.current.has(scopeKey)) {
      clearComposerDraftSnapshot(scopeKey);
      return;
    }

    saveComposerDraftSnapshot(scopeKey, snapshot);
    persistLaunchpadDraftSnapshot(scopeKey, snapshot);
  };
  const updateActiveTurnId = (nextTurnId?: string): void => {
    activeTurnIdRef.current = nextTurnId;
    setActiveTurnId(nextTurnId);
  };
  const trigger = findSkillTrigger(draft, selectionStart);
  const slashTrigger = findSlashCommandTrigger(draft, selectionStart);
  const filteredSkills = useMemo(() => {
    if (!trigger) {
      return [];
    }

    const normalizedQuery = trigger.query.trim().toLowerCase();
    return props.skills
      .map((skill, index) => ({
        index,
        score: skill.path
          ? rankSkillAutocompleteMatch(skill, normalizedQuery)
          : undefined,
        skill,
      }))
      .filter(
        (match): match is { index: number; score: number; skill: AppServerSkillSummary } =>
          match.score !== undefined
      )
      .sort((left, right) => {
        if (left.score !== right.score) {
          return left.score - right.score;
        }
        return left.index - right.index;
      })
      .map((match) => match.skill);
  }, [props.skills, trigger]);
  const filteredSlashCommands = useMemo(() => {
    if (!slashTrigger) {
      return [];
    }

    const typed = draft.slice(slashTrigger.start, slashTrigger.end).trim().toLowerCase();
    return SLASH_COMMANDS.filter(
      (command) =>
        command.label.toLowerCase().startsWith(typed) ||
        command.description.toLowerCase().includes(typed.slice(1))
    );
  }, [draft, slashTrigger]);
  const availableAutocompleteKind: AutocompleteKind | undefined = trigger && filteredSkills.length > 0
    ? "skills"
    : slashTrigger && filteredSlashCommands.length > 0
      ? "slash"
      : undefined;
  const autocompleteKey =
    availableAutocompleteKind === "skills" && trigger
      ? `skills:${trigger.start}:${trigger.end}:${trigger.query}`
      : availableAutocompleteKind === "slash" && slashTrigger
        ? `slash:${slashTrigger.start}:${slashTrigger.end}:${draft.slice(
            slashTrigger.start,
            slashTrigger.end,
          )}`
        : undefined;
  const displayedAutocompleteKind =
    autocompleteKey && autocompleteKey === dismissedAutocompleteKey
      ? undefined
      : availableAutocompleteKind;
  const autocompleteKind: AutocompleteKind | undefined = reviewConfig
    ? undefined
    : displayedAutocompleteKind;
  const hasAutocomplete = Boolean(autocompleteKind);
  const activeAutocompleteIndex =
    autocompleteKind === "skills" ? activeSkillIndex : activeSlashIndex;
  const autocompleteLength =
    autocompleteKind === "skills"
      ? filteredSkills.length
      : filteredSlashCommands.length;
  const autocompleteListboxId =
    autocompleteKind === "skills"
      ? skillListboxId
      : autocompleteKind === "slash"
        ? slashListboxId
        : undefined;
  const activeAutocompleteOptionId =
    autocompleteListboxId && autocompleteKind
      ? `${autocompleteListboxId}-option-${activeAutocompleteIndex}`
      : undefined;
  const reviewBranchOptions = useMemo(
    () => buildReviewBranchOptions({
      directory: props.directory,
      thread: props.thread,
    }),
    [props.directory, props.thread]
  );
  const isBareReviewCommand = draft.trim() === "/review";
  const isReviewComposerOpen = Boolean(reviewConfig && isBareReviewCommand);

  useEffect(() => {
    return () => {
      const latest = latestDraftSnapshotRef.current;
      flushComposerDraftSnapshot(latest.scopeKey, latest.snapshot);
    };
  }, []);

  useEffect(() => {
    const previousScopeKey = activeComposerScopeKeyRef.current;
    if (previousScopeKey === composerScopeKey) {
      return;
    }

    recoveryEligibilityVersionRef.current += 1;
    recoveryLookupSequenceRef.current += 1;
    const previousSnapshot = {
      draft,
      editorDocument,
      imageAttachments,
      skillTokens,
    };
    flushComposerDraftSnapshot(previousScopeKey, previousSnapshot);

    activeComposerScopeKeyRef.current = composerScopeKey;
    const current = pasteScopeRef.current;
    pasteScopeRef.current = {
      key: composerScopeKey,
      version: current.version + 1,
    };

    if (props.thread) {
      const saved = draftStore.get(composerScopeKey);
      const savedPendingSteer = draftStore.getPendingSteer(composerScopeKey);
      const savedQueuedTurns = draftStore.getQueuedTurns(composerScopeKey);
      setDraft(saved?.draft ?? "");
      setEditorDocument(saved?.editorDocument);
      setImageAttachments(saved?.imageAttachments ?? []);
      setSkillTokens(saved?.skillTokens ?? []);
      setPendingSteerState(
        savedPendingSteer ? { ...savedPendingSteer, status: "pending" } : undefined
      );
      setQueuedTurnsState(savedQueuedTurns);
    } else {
      setPendingSteerState(undefined);
      setQueuedTurnsState([]);
    }
    updateSending(false);
    setInterrupting(false);
    setSteering(false);
    updateActiveTurnId(undefined);
    setActiveOptimisticMessageId(undefined);
    setReviewConfig(undefined);
  }, [composerScopeKey, draft, editorDocument, imageAttachments, skillTokens]);

  useEffect(() => {
    const saved = draftStore.get(composerScopeKey);
    if (!saved) {
      return;
    }
    const latest = latestDraftSnapshotRef.current;
    if (latest.scopeKey !== composerScopeKey) {
      return;
    }
    if (
      latest.snapshot.draft.trim() ||
      latest.snapshot.skillTokens.length > 0 ||
      latest.snapshot.imageAttachments.length > 0
    ) {
      return;
    }

    setDraft(saved.draft);
    setEditorDocument(saved.editorDocument);
    setImageAttachments(saved.imageAttachments);
    setSkillTokens(saved.skillTokens);
  }, [composerScopeKey, draftStore, draftStoreHydrationVersion]);

  useEffect(() => {
    setActiveSkillIndex(0);
  }, [trigger?.query, props.launchpad?.directoryKey, props.thread?.id]);

  useEffect(() => {
    setActiveSlashIndex(0);
  }, [slashTrigger?.query, props.launchpad?.directoryKey, props.thread?.id]);

  useEffect(() => {
    deletedSkillTokenHistoryRef.current = [];
    if (skillTokens.length === 0 && draft.includes("](")) {
      const hydrated = hydrateComposerDraft(draft, props.skills);
      if (hydrated.skillTokens.length > 0) {
        setDraft(hydrated.draft);
        setSkillTokens(hydrated.skillTokens);
      }
    }
  }, [draft, props.skills, skillTokens.length]);

  useEffect(() => {
    if (!autocompleteKind) {
      return;
    }

    autocompleteOptionRefs.current[activeAutocompleteIndex]?.scrollIntoView?.({
      block: "nearest",
    });
  }, [activeAutocompleteIndex, autocompleteKind]);

  useEffect(() => {
    if (!autocompleteKind) {
      return;
    }

    const updateAutocompleteLayout = (): void => {
      const inputWrap = inputWrapRef.current;
      if (!inputWrap) {
        return;
      }

      const viewportPadding = 12;
      const gap = 10;
      const rect = inputWrap.getBoundingClientRect();
      const availableAbove = rect.top - viewportPadding - gap;
      const availableBelow = window.innerHeight - rect.bottom - viewportPadding - gap;
      const placement =
        availableAbove >= 180 || availableAbove >= availableBelow ? "above" : "below";
      const available = placement === "above" ? availableAbove : availableBelow;
      setAutocompleteLayout({
        placement,
        maxHeight: Math.max(140, Math.min(320, available)),
      });
    };

    updateAutocompleteLayout();
    window.addEventListener("resize", updateAutocompleteLayout);
    return () => {
      window.removeEventListener("resize", updateAutocompleteLayout);
    };
  }, [activeAutocompleteIndex, autocompleteKind]);

  useEffect(() => {
    if (!trigger) {
      return;
    }

    void props.onEnsureSkillsLoaded?.();
  }, [props.onEnsureSkillsLoaded, trigger]);

  useEffect(() => {
    if (!isLaunchpad) {
      hydratedLaunchpadKeyRef.current = undefined;
      return;
    }

    if (hydratedLaunchpadKeyRef.current === props.launchpad?.directoryKey) {
      return;
    }

    hydratedLaunchpadKeyRef.current = props.launchpad?.directoryKey;
    const saved = draftStore.get(composerScopeKey);
    if (saved) {
      setDraft(saved.draft);
      setEditorDocument(saved.editorDocument);
      setImageAttachments(saved.imageAttachments);
      setSkillTokens(saved.skillTokens);
    } else {
      setComposerDraftFromCanonical(props.launchpad?.prompt ?? "");
      setEditorDocument(
        props.launchpad?.editorDocument as JSONContent | undefined,
      );
      setImageAttachments(props.launchpad?.imageAttachments ?? []);
    }
    updateSending(false);
    setInterrupting(false);
    setSteering(false);
    updateActiveTurnId(undefined);
    setActiveOptimisticMessageId(undefined);
    setReviewConfig(undefined);
    setQueuedTurnsState([]);
    setPendingSteer(undefined);
    window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
  }, [
    composerScopeKey,
    draftStore,
    isLaunchpad,
    props.launchpad?.directoryKey,
    props.launchpad?.prompt,
    props.skills,
  ]);

  useEffect(() => {
    if (!props.thread) {
      return;
    }

    activeComposerScopeKeyRef.current = composerScopeKey;
  }, [composerScopeKey, props.thread]);

  useEffect(() => {
    updateActiveTurnId(props.activeTurnId);

    if (!props.activeTurnId) {
      updateSending(false);
      setInterrupting(false);
      setSteering(false);
    }
  }, [props.activeTurnId]);

  useEffect(() => {
    if (!props.desktopApi?.onAgentEvent || !props.thread) {
      return;
    }

    const thread = props.thread;

    return props.desktopApi.onAgentEvent((event) => {
      const notificationThreadId =
        "threadId" in event.notification.params &&
        typeof event.notification.params.threadId === "string"
          ? event.notification.params.threadId
          : undefined;
      const statusRecord =
        event.notification.method === "thread/status/changed" &&
        typeof event.notification.params.status === "object" &&
        event.notification.params.status !== null
          ? (event.notification.params.status as { type?: unknown })
          : undefined;
      const startedTurnRecord =
        event.notification.method === "turn/started" &&
        typeof event.notification.params.turn === "object" &&
        event.notification.params.turn !== null
          ? (event.notification.params.turn as { id?: unknown })
          : undefined;

      if (event.backend !== thread.source || notificationThreadId !== thread.id) {
        return;
      }

      if (
        pendingSteer?.status === "steering" &&
        event.notification.method === "item/completed" &&
        notificationIncludesDraftText(event.notification.params, pendingSteer)
      ) {
        setPendingSteer(undefined);
        setSteering(false);
        props.onPendingStatusChange?.("Thinking");
      }

      if (
        pendingSteer?.status === "pending" &&
        activeTurnIdRef.current &&
        isSteerInjectionOpportunity(event.notification.method)
      ) {
        void submitPendingSteer(pendingSteer);
      }

      if (
        event.notification.method === "turn/started" &&
        typeof startedTurnRecord?.id === "string"
      ) {
        updateActiveTurnId(startedTurnRecord.id);
        props.onActiveTurnIdChange?.(startedTurnRecord.id);
      }

      if (
        event.notification.method === "turn/completed" ||
        event.notification.method === "turn/failed" ||
        event.notification.method === "turn/cancelled"
      ) {
        if (
          activeOptimisticMessageId &&
          (event.notification.method === "turn/failed" ||
            event.notification.method === "turn/cancelled")
        ) {
          props.removeOptimisticMessage?.(activeOptimisticMessageId);
        }
        props.onPendingStatusChange?.(undefined);
        updateSending(false);
        setInterrupting(false);
        setSteering(false);
        if (pendingSteer?.status === "pending") {
          if (queuedTurn) {
            setComposerDraftFromCanonical(pendingSteer.text);
            setImageAttachments(pendingSteer.imageAttachments);
          } else {
            setQueuedTurn({
              id: createQueuedTurnId(),
              text: pendingSteer.text,
              imageAttachments: pendingSteer.imageAttachments,
            });
          }
        }
        setPendingSteer(undefined);
        updateActiveTurnId(undefined);
        props.onActiveTurnIdChange?.(undefined);
        setActiveOptimisticMessageId(undefined);
        return;
      }

      if (
        event.notification.method === "thread/status/changed" &&
        statusRecord?.type === "idle"
      ) {
        if (activeTurnIdRef.current) {
          return;
        }

        props.onPendingStatusChange?.(undefined);
        updateSending(false);
        setInterrupting(false);
        setSteering(false);
        setPendingSteer(undefined);
        updateActiveTurnId(undefined);
        props.onActiveTurnIdChange?.(undefined);
        setActiveOptimisticMessageId(undefined);
      }
    });
  }, [
    activeOptimisticMessageId,
    props.desktopApi,
    props.onActiveTurnIdChange,
    props.onPendingStatusChange,
    props.removeOptimisticMessage,
    props.thread,
    pendingSteer,
    queuedTurn,
  ]);

  useEffect(() => {
    if (!launchpad || !props.onUpdateLaunchpad) {
      return;
    }

    const editorDocumentChanged =
      JSON.stringify(launchpad.editorDocument) !== JSON.stringify(editorDocument);
    if (canonicalDraft === launchpad.prompt && !editorDocumentChanged) {
      return;
    }

    const timeout = window.setTimeout(() => {
      if (submittedDraftScopeKeysRef.current.has(composerScopeKey)) {
        return;
      }

      void props.onUpdateLaunchpad?.(launchpad.directoryKey, {
        imageAttachments: imageAttachments.length > 0 ? imageAttachments : undefined,
        prompt: canonicalDraft,
        editorDocument: editorDocument as Record<string, unknown> | undefined,
      });
    }, 250);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [
    canonicalDraft,
    composerScopeKey,
    editorDocument,
    imageAttachments,
    launchpad,
    props.onUpdateLaunchpad,
  ]);

  const submitReviewCommand = async (reviewCommand: {
    displayText: string;
    target: AppServerReviewTarget;
  }, options?: {
    queueClaimed?: boolean;
    queued?: QueuedTurnDraft;
  }): Promise<void> => {
    if (props.disabled) {
      restoreQueuedTurnIfClaimed(options?.queued, options?.queueClaimed);
      return;
    }
    if (!options?.queued && imageAttachments.length > 0) {
      setSendError("/review does not accept image attachments.");
      return;
    }
    if (!options?.queued && shouldQueueThreadSubmit()) {
      queueReviewCommand(reviewCommand);
      return;
    }

    setSendError(undefined);
    updateSending(true);
    props.onPendingStatusChange?.("Reviewing");

    if (props.launchpad && props.onMaterializeLaunchpad) {
      const submittedScopeKey = composerScopeKey;
      markComposerDraftSubmitted(submittedScopeKey);
      props.onPendingStatusChange?.(
        props.launchpad.codexEnvironmentId &&
          props.launchpad.codexEnvironmentSetupEnabled
          ? "Running environment setup"
          : "Reviewing",
      );
      try {
        await props.onMaterializeLaunchpad(
          props.launchpad.directoryKey,
          undefined,
          undefined,
          reviewCommand.target
        );
        clearSubmittedComposerDraft(submittedScopeKey);
        setReviewConfig(undefined);
      } catch (error) {
        unmarkComposerDraftSubmitted(submittedScopeKey);
        props.onPendingStatusChange?.(undefined);
        restoreQueuedTurnIfClaimed(options?.queued, options?.queueClaimed);
        setSendError(error instanceof Error ? error.message : String(error));
      } finally {
        updateSending(false);
      }
      return;
    }

    if (!props.thread || !props.desktopApi?.startReview) {
      props.onPendingStatusChange?.(undefined);
      updateSending(false);
      restoreQueuedTurnIfClaimed(options?.queued, options?.queueClaimed);
      return;
    }

    const optimisticReviewId = props.addOptimisticReviewEntry?.(
      reviewCommand.displayText
    );
    setActiveOptimisticMessageId(optimisticReviewId);
    try {
      const response = await props.desktopApi.startReview({
        backend: props.thread.source,
        threadId: props.thread.id,
        target: reviewCommand.target,
        delivery: "inline",
      });
      updateActiveTurnId(response.turnId);
      props.onActiveTurnIdChange?.(response.turnId);
      if (options?.queued) {
        if (!options.queueClaimed) {
          removeQueuedTurn(options.queued);
        }
      } else {
        recordComposerDraftHistory(
          composerScopeKey,
          latestDraftSnapshotRef.current.snapshot,
          "sent",
        );
        clearComposerDraftSnapshot(composerScopeKey);
        clearComposerDraft();
        setReviewConfig(undefined);
      }
    } catch (error) {
      if (optimisticReviewId) {
        props.removeOptimisticMessage?.(optimisticReviewId);
      }
      props.onPendingStatusChange?.(undefined);
      updateSending(false);
      setInterrupting(false);
      updateActiveTurnId(undefined);
      props.onActiveTurnIdChange?.(undefined);
      restoreQueuedTurnIfClaimed(options?.queued, options?.queueClaimed);
      setSendError(error instanceof Error ? error.message : String(error));
    }
  };

  const enterReviewComposer = (): void => {
    setReviewConfig(
      createReviewConfig({
        directory: props.directory,
        thread: props.thread,
      })
    );
    updateVisibleDraft("/review");
    setDismissedAutocompleteKey(autocompleteKey);
    setActiveSkillIndex(0);
    setActiveSlashIndex(0);
    setSendError(undefined);
  };

  const exitReviewComposer = (): void => {
    setReviewConfig(undefined);
    clearComposerDraft();
    setSendError(undefined);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const buildTurnPayload = (
    textDraft: string,
    attachments: ComposerImageAttachment[],
  ): {
    displayText: string;
    imageParts: AppServerThreadImagePart[];
    input: AppServerTurnInputItem[];
  } => {
    const turnSkills = listMentionedSkills(textDraft, props.skills);
    const displayText = hydrateSkillLabelsWithMarkdown(textDraft.trim(), turnSkills);
    const imageParts = attachments.map((attachment, index) => ({
      type: "image" as const,
      url: attachment.url,
      alt: formatPastedImageAlt(attachment, index),
    }));
    const input: AppServerTurnInputItem[] = [
      ...(displayText ? [{ type: "text" as const, text: displayText }] : []),
      ...imageParts.map(({ url }) => ({ type: "image" as const, url })),
    ];

    return { displayText, imageParts, input };
  };

  const sendThreadTurn = async (
    queued?: QueuedTurnDraft,
    options?: { queueClaimed?: boolean },
  ): Promise<void> => {
    if (!props.thread || !props.desktopApi?.startTurn) {
      restoreQueuedTurnIfClaimed(queued, options?.queueClaimed);
      return;
    }

    const payload = queued
      ? buildTurnPayload(queued.text, queued.imageAttachments)
      : buildTurnPayload(canonicalDraft, imageAttachments);
    if (payload.input.length === 0 || props.disabled) {
      restoreQueuedTurnIfClaimed(queued, options?.queueClaimed);
      return;
    }

    const collaborationMode =
      !queued && planModeEnabled && supportsPlanMode
        ? ({
            mode: "plan",
            settings: {
              developerInstructions: null,
            },
          } satisfies AppServerCollaborationModeRequest)
        : undefined;

    if (props.onBeforeStartTurn && !(await props.onBeforeStartTurn())) {
      updateSending(false);
      restoreQueuedTurnIfClaimed(queued, options?.queueClaimed);
      return;
    }

    props.onBeforeSendTurn?.();
    props.onPendingStatusChange?.(collaborationMode ? "Planning" : "Thinking");
    const optimisticMessageId = props.addOptimisticUserMessage?.(
      payload.displayText,
      payload.imageParts
    );
    setActiveOptimisticMessageId(optimisticMessageId);

    try {
      const response = await props.desktopApi.startTurn({
        backend: props.thread.source,
        threadId: props.thread.id,
        input: payload.input,
        executionMode: props.thread.executionMode,
        collaborationMode,
        model: selectedModelOption?.id,
        reasoningEffort: supportsReasoning ? selectedReasoningEffort : undefined,
        serviceTier: selectedServiceTier,
        fastMode: props.thread.source === "codex" && supportsFast
          ? Boolean(currentSettings?.fastMode)
          : undefined,
      });
      updateActiveTurnId(response.turnId);
      props.onActiveTurnIdChange?.(response.turnId);
      if (queued) {
        if (!options?.queueClaimed) {
          removeQueuedTurn(queued);
        }
      } else {
        recordComposerDraftHistory(
          composerScopeKey,
          latestDraftSnapshotRef.current.snapshot,
          "sent",
        );
        clearComposerDraftSnapshot(composerScopeKey);
        clearComposerDraft();
        setImageAttachments([]);
        if (collaborationMode) {
          setPlanModeEnabled(false);
        }
      }
    } catch (error) {
      if (optimisticMessageId) {
        props.removeOptimisticMessage?.(optimisticMessageId);
      }
      props.onPendingStatusChange?.(undefined);
      updateSending(false);
      setInterrupting(false);
      setSteering(false);
      updateActiveTurnId(undefined);
      props.onActiveTurnIdChange?.(undefined);
      setActiveOptimisticMessageId(undefined);
      restoreQueuedTurnIfClaimed(queued, options?.queueClaimed);
      setSendError(error instanceof Error ? error.message : String(error));
    }
  };

  const sendQueuedTurn = async (queued: QueuedTurnDraft): Promise<void> => {
    const claimedQueuedTurn = claimQueuedTurn(queued);
    if (!claimedQueuedTurn) {
      return;
    }

    if (claimedQueuedTurn.reviewCommand) {
      await submitReviewCommand(claimedQueuedTurn.reviewCommand, {
        queueClaimed: true,
        queued: claimedQueuedTurn,
      });
      return;
    }

    await sendThreadTurn(claimedQueuedTurn, { queueClaimed: true });
  };

  useEffect(() => {
    if (activeTurnId) {
      queuedAutoReleaseAttemptIdRef.current = undefined;
      return;
    }
    if (!queuedTurn || activeTurnId || sending || props.launchpad || props.disabled) {
      return;
    }
    if (queuedAutoReleaseAttemptIdRef.current === queuedTurn.id) {
      return;
    }

    queuedAutoReleaseAttemptIdRef.current = queuedTurn.id;
    updateSending(true);
    void sendQueuedTurn(queuedTurn).finally(() => {
      updateSending(false);
    });
  }, [activeTurnId, queuedTurn, sending, props.disabled, props.launchpad]);

  useEffect(() => {
    if (
      !pendingSteer ||
      pendingSteer.status !== "pending" ||
      activeTurnId ||
      props.launchpad
    ) {
      return;
    }

    if (queuedTurn) {
      setComposerDraftFromCanonical(pendingSteer.text);
      setImageAttachments(pendingSteer.imageAttachments);
    } else {
      setQueuedTurn({
        id: createQueuedTurnId(),
        text: pendingSteer.text,
        imageAttachments: pendingSteer.imageAttachments,
      });
    }
    setPendingSteer(undefined);
  }, [activeTurnId, pendingSteer, props.launchpad, queuedTurn]);

  const queueCurrentDraft = (): void => {
    if (!hasComposerContent && imageAttachments.length === 0) {
      return;
    }

    const payload = buildTurnPayload(canonicalDraft, imageAttachments);
    if (payload.input.length === 0) {
      return;
    }

    enqueueQueuedTurn({
      id: createQueuedTurnId(),
      input: payload.input,
      text: canonicalDraft,
      imageAttachments,
    });
    recordComposerDraftHistory(
      composerScopeKey,
      latestDraftSnapshotRef.current.snapshot,
      "unsent",
    );
    clearComposerDraftSnapshot(composerScopeKey);
    clearComposerDraft();
    setImageAttachments([]);
    setReviewConfig(undefined);
    setSendError(undefined);
  };

  const queueReviewCommand = (reviewCommand: {
    displayText: string;
    target: AppServerReviewTarget;
  }): void => {
    enqueueQueuedTurn({
      id: createQueuedTurnId(),
      text: reviewCommandToDraftText(reviewCommand),
      imageAttachments: [],
      reviewCommand,
    });
    recordComposerDraftHistory(
      composerScopeKey,
      latestDraftSnapshotRef.current.snapshot,
      "unsent",
    );
    clearComposerDraftSnapshot(composerScopeKey);
    clearComposerDraft();
    setImageAttachments([]);
    setReviewConfig(undefined);
    setSendError(undefined);
  };

  const shouldQueueThreadSubmit = (): boolean =>
    !props.launchpad && (Boolean(activeTurnIdRef.current) || sendingRef.current);

  const submitPendingSteer = async (pending: QueuedTurnDraft): Promise<void> => {
    const turnId = activeTurnIdRef.current;
    if (!props.thread || !turnId || !props.desktopApi?.steerTurn) {
      setSendError("Steering is not available for this backend.");
      return;
    }
    if (!supportsSteering) {
      setSendError("Steering is not available for this model.");
      return;
    }

    const payload = buildTurnPayload(pending.text, pending.imageAttachments);
    if (payload.input.length === 0 || props.disabled || steering) {
      return;
    }

    setSendError(undefined);
    setSteering(true);
    updatePendingSteer((current) =>
      current?.text === pending.text &&
      current.imageAttachments === pending.imageAttachments
        ? { ...current, status: "steering" }
        : current
    );
    props.onPendingStatusChange?.("Steering");
    try {
      await props.desktopApi.steerTurn({
        backend: props.thread.source,
        threadId: props.thread.id,
        expectedTurnId: turnId,
        input: payload.input,
      });
    } catch (error) {
      const staleSteer = parseStaleSteerError(error);
      if (staleSteer) {
        if (queuedTurn) {
          setDraft(pending.text);
          setImageAttachments(pending.imageAttachments);
        } else {
          setQueuedTurn({
            id: createQueuedTurnId(),
            text: pending.text,
            imageAttachments: pending.imageAttachments,
          });
        }
        setPendingSteer(undefined);
        setSendError(undefined);
        const nextActiveTurnId = staleSteer.active ? staleSteer.activeTurnId : undefined;
        updateActiveTurnId(nextActiveTurnId);
        props.onActiveTurnIdChange?.(nextActiveTurnId);
        props.onPendingStatusChange?.(staleSteer.active ? "Thinking" : undefined);
        return;
      }
      updatePendingSteer((current) =>
        current?.text === pending.text &&
        current.imageAttachments === pending.imageAttachments
          ? { ...current, status: "pending" }
          : current
      );
      props.onPendingStatusChange?.("Thinking");
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      setSteering(false);
    }
  };

  const createPendingSteer = (pending: QueuedTurnDraft): boolean => {
    const turnId = activeTurnIdRef.current;
    if (!props.thread || !turnId || !props.desktopApi?.steerTurn || !supportsSteering) {
      setSendError("Steering is not available for this model.");
      return false;
    }

    const payload = buildTurnPayload(pending.text, pending.imageAttachments);
    if (payload.input.length === 0 || props.disabled || pendingSteer) {
      return false;
    }

    setSendError(undefined);
    setPendingSteer({
      id: pending.id,
      text: pending.text,
      imageAttachments: pending.imageAttachments,
      status: "pending",
    });
    recordComposerDraftHistory(
      composerScopeKey,
      latestDraftSnapshotRef.current.snapshot,
      "unsent",
    );
    clearComposerDraftSnapshot(composerScopeKey);
    clearComposerDraft();
    setImageAttachments([]);
    setReviewConfig(undefined);
    return true;
  };

  const steerCurrentDraft = (): void => {
    if (!props.thread || !activeTurnIdRef.current || !props.desktopApi?.steerTurn) {
      queueCurrentDraft();
      setSendError("Steering is not available for this backend.");
      return;
    }
    if (!supportsSteering) {
      queueCurrentDraft();
      setSendError("Steering is not available for this model.");
      return;
    }

    createPendingSteer({
      id: createQueuedTurnId(),
      text: canonicalDraft,
      imageAttachments,
    });
  };

  const steerQueuedTurn = (queued: QueuedTurnDraft): void => {
    if (!createPendingSteer(queued)) {
      return;
    }
    removeQueuedTurn(queued);
    if (activeTurnIdRef.current) {
      void submitPendingSteer(queued);
    }
  };

  const submitTurn = async (mode: "default" | "steer" = "default"): Promise<void> => {
    const reviewCommand = parseReviewCommand(draft);
    if (shouldQueueThreadSubmit()) {
      if (activeTurnIdRef.current && mode === "steer") {
        steerCurrentDraft();
      } else if (reviewCommand && isBareReviewCommand) {
        setReviewConfig(
          reviewConfig ??
            createReviewConfig({
              directory: props.directory,
              thread: props.thread,
            })
        );
        setSendError(undefined);
      } else if (reviewCommand) {
        if (imageAttachments.length > 0) {
          setSendError("/review does not accept image attachments.");
          return;
        }
        queueReviewCommand(reviewCommand);
      } else {
        queueCurrentDraft();
      }
      return;
    }

    if (reviewCommand) {
      if (isBareReviewCommand) {
        const nextReviewConfig =
          reviewConfig ??
          createReviewConfig({
            directory: props.directory,
            thread: props.thread,
          });
        const configuredReviewCommand = buildConfiguredReviewCommand(nextReviewConfig);
        if (!configuredReviewCommand) {
          setReviewConfig(nextReviewConfig);
          setSendError(undefined);
          return;
        }
        await submitReviewCommand(configuredReviewCommand);
        return;
      }

      await submitReviewCommand(reviewCommand);
      return;
    }

    const payload = buildTurnPayload(canonicalDraft, imageAttachments);
    const collaborationMode = planModeEnabled && supportsPlanMode
      ? ({
          mode: "plan",
          settings: {
            developerInstructions: null,
          },
        } satisfies AppServerCollaborationModeRequest)
      : undefined;

    if (payload.input.length === 0 || props.disabled) {
      return;
    }

    setSendError(undefined);
    updateSending(true);

    if (props.launchpad && props.onMaterializeLaunchpad) {
      const submittedScopeKey = composerScopeKey;
      markComposerDraftSubmitted(submittedScopeKey);
      props.onPendingStatusChange?.(
        props.launchpad.codexEnvironmentId &&
          props.launchpad.codexEnvironmentSetupEnabled
          ? "Running environment setup"
          : collaborationMode
            ? "Planning"
            : "Thinking",
      );
      try {
        await props.onMaterializeLaunchpad(
          props.launchpad.directoryKey,
          payload.input,
          collaborationMode
        );
        clearSubmittedComposerDraft(submittedScopeKey);
        if (collaborationMode) {
          setPlanModeEnabled(false);
        }
      } catch (error) {
        unmarkComposerDraftSubmitted(submittedScopeKey);
        props.onPendingStatusChange?.(undefined);
        setSendError(error instanceof Error ? error.message : String(error));
      } finally {
        updateSending(false);
      }
      return;
    }

    if (!props.thread || !props.desktopApi?.startTurn) {
      updateSending(false);
      return;
    }

    await sendThreadTurn();
  };

  const stopTurn = async (): Promise<void> => {
    const turnId = activeTurnIdRef.current;
    if (
      !props.thread ||
      !turnId ||
      !props.desktopApi?.interruptTurn ||
      interrupting
    ) {
      return;
    }

    setSendError(undefined);
    setInterrupting(true);
    props.onPendingStatusChange?.("Stopping");

    try {
      await props.desktopApi.interruptTurn({
        backend: props.thread.source,
        threadId: props.thread.id,
        turnId,
      });
    } catch (error) {
      setInterrupting(false);
      props.onPendingStatusChange?.(
        props.pendingRequestActive
          ? "Waiting for approval"
          : props.pendingUserInputActive
            ? "Waiting for input"
            : "Thinking"
      );
      setSendError(error instanceof Error ? error.message : String(error));
    }
  };

  const applySkill = (skill: AppServerSkillSummary): void => {
    if (!inputRef.current) {
      return;
    }

    const selectionStart = Math.min(
      inputRef.current.selectionStart ?? draft.length,
      draft.length,
    );
    const selectionEnd = Math.min(
      inputRef.current.selectionEnd ?? selectionStart,
      draft.length,
    );
    const trigger =
      findSkillTrigger(draft, selectionStart) ?? findSkillTrigger(draft, draft.length);
    if (!trigger) {
      return;
    }

    const before = draft.slice(0, trigger.start);
    const after = draft.slice(Math.max(trigger.end, selectionEnd));
    const nextAfter = after.length > 0 && !/^\s/.test(after) ? ` ${after}` : after;
    const nextDraft = `${before}${nextAfter}`;
    const tokenIndex = before.length;
    const nextSkillTokens = [
      ...adjustSkillTokenIndexesForTextChange({
        currentDraft: draft,
        nextDraft,
        skillTokens,
      }),
      createComposerSkillToken(skill, tokenIndex),
    ];

    pendingProgrammaticComposerChangeRef.current = {
      expectedDraft: nextDraft,
      expectedSkillTokensSignature:
        getComposerSkillTokensSignature(nextSkillTokens),
      staleDraft: draft,
      staleSkillTokensSignature: getComposerSkillTokensSignature(skillTokens),
    };
    flushSync(() => {
      setSkillTokens(nextSkillTokens);
      setDraft(nextDraft);
      setActiveSkillIndex(0);
    });
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const applySlashCommand = (command: SlashCommandSuggestion): void => {
    if (!inputRef.current) {
      return;
    }

    if (command.id === "review-current") {
      enterReviewComposer();
      return;
    }

    if (shouldQueueThreadSubmit()) {
      queueCurrentDraft();
      return;
    }

    const selectionStart = Math.min(
      inputRef.current.selectionStart ?? draft.length,
      draft.length,
    );
    const selectionEnd = Math.min(
      inputRef.current.selectionEnd ?? selectionStart,
      draft.length,
    );
    const trigger = findSlashCommandTrigger(draft, selectionStart);
    if (!trigger) {
      return;
    }

    const before = draft.slice(0, trigger.start);
    const after = draft.slice(Math.max(trigger.end, selectionEnd));
    const needsTrailingSpace = after.length === 0 || !/^\s/.test(after);
    const nextDraft = `${before}${command.insertText}${needsTrailingSpace ? " " : ""}${after}`;
    const nextSelection = before.length + command.insertText.length + (needsTrailingSpace ? 1 : 0);

    updateVisibleDraft(nextDraft);
    setActiveSlashIndex(0);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextSelection, nextSelection);
    });
  };

  const removeImageAttachment = (id: string): void => {
    setImageAttachments((current) => {
      const nextAttachments = current.filter((attachment) => attachment.id !== id);
      saveComposerDraftSnapshot(composerScopeKey, {
        draft,
        editorDocument,
        imageAttachments: nextAttachments,
        skillTokens,
      });
      persistLaunchpadImageAttachments(nextAttachments);
      return nextAttachments;
    });
  };

  const persistLaunchpadImageAttachments = (
    attachments: ComposerImageAttachment[],
  ): void => {
    if (!props.launchpad || !props.onUpdateLaunchpad) {
      return;
    }

    void props.onUpdateLaunchpad(props.launchpad.directoryKey, {
      imageAttachments: attachments.length > 0 ? attachments : undefined,
      prompt: canonicalDraft,
    });
  };

  const handlePaste = (event: ClipboardEvent<HTMLElement>): void => {
    const pastedFiles = getImageFilesFromDataTransfer(event.clipboardData);
    if (pastedFiles.length === 0) {
      return;
    }

    event.preventDefault();
    setSendError(undefined);
    void attachImages(pastedFiles);
  };

  const handleDragOver = (event: DragEvent<HTMLElement>): void => {
    if (!hasImageFiles(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleDrop = (event: DragEvent<HTMLElement>): void => {
    const droppedFiles = getImageFilesFromDataTransfer(event.dataTransfer);
    if (droppedFiles.length === 0) {
      return;
    }

    event.preventDefault();
    setSendError(undefined);
    void attachImages(droppedFiles);
  };

  const attachImages = async (files: ComposerImageFile[]): Promise<void> => {
    const pasteScope = pasteScopeRef.current;
    const pasteDraft = draft;
    const pasteEditorDocument = editorDocument;
    const pasteImageAttachments = imageAttachments;

    try {
      const nextAttachments = await Promise.all(
        files.map(async ({ file, type }, index) => {
          const fallbackName = formatPastedImageName(type, index);
          if (isGifFile(file, type)) {
            return {
              id: `pasted-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
              name: file.name || fallbackName,
              size: file.size,
              type: "image/gif",
              url: await readFileAsImageDataUrl(file, "image/gif"),
            };
          }

          const normalized = await normalizeImageFile(file, {
            fallback: props.desktopApi?.normalizeImageForUpload,
            maxPatchCount: props.pastedImageMaxPatches,
          });
          void props.desktopApi?.recordImageUploadNormalization?.({
            fileName: file.name || fallbackName,
            original: {
              height: normalized.original.height,
              mimeType: normalized.original.mimeType,
              size: normalized.original.size,
              width: normalized.original.width,
            },
            normalized: {
              height: normalized.height,
              mimeType: normalized.mimeType,
              size: normalized.size,
              width: normalized.width,
            },
            path: normalized.conversionPath,
            resized:
              normalized.original.width !== normalized.width ||
              normalized.original.height !== normalized.height,
          });
          return {
            id: `pasted-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name || fallbackName,
            size: normalized.size,
            type: normalized.mimeType,
            url: normalized.dataUrl,
            width: normalized.width,
            height: normalized.height,
          };
        })
      );

      if (activeComposerScopeKeyRef.current !== pasteScope.key) {
        const saved = draftStore.get(pasteScope.key) ?? {
          draft: pasteDraft,
          editorDocument: pasteEditorDocument,
          imageAttachments: pasteImageAttachments,
          skillTokens,
        };
        const nextSnapshot = {
          draft: saved.draft,
          editorDocument: saved.editorDocument,
          imageAttachments: [...saved.imageAttachments, ...nextAttachments],
          skillTokens: saved.skillTokens,
        };
        saveComposerDraftSnapshot(pasteScope.key, nextSnapshot);
        persistLaunchpadDraftSnapshot(pasteScope.key, nextSnapshot);
        return;
      }

      setImageAttachments((current) => {
        const mergedAttachments = [...current, ...nextAttachments];
        const nextSnapshot = {
          draft,
          editorDocument,
          imageAttachments: mergedAttachments,
          skillTokens,
        };
        saveComposerDraftSnapshot(pasteScope.key, nextSnapshot);
        persistLaunchpadImageAttachments(mergedAttachments);
        return mergedAttachments;
      });
    } catch (error) {
      if (activeComposerScopeKeyRef.current !== pasteScope.key) {
        return;
      }

      setSendError(
        error instanceof Error ? error.message : "The pasted image could not be read."
      );
    }
  };

  const handleLaunchpadPatch = (
    patch: Partial<
      Pick<
        NavigationLaunchpadDraft,
        | "backend"
        | "executionMode"
        | "model"
        | "reasoningEffort"
        | "serviceTier"
        | "fastMode"
        | "workMode"
        | "branchName"
        | "codexEnvironmentId"
        | "codexEnvironmentExecutionTarget"
        | "codexEnvironmentSetupEnabled"
        | "codexEnvironmentActionId"
      >
    >
  ): void => {
    if (!props.launchpad || !props.onUpdateLaunchpad) {
      return;
    }

    setSendError(undefined);
    void props.onUpdateLaunchpad(
      props.launchpad.directoryKey,
      {
        imageAttachments:
          imageAttachments.length > 0 ? imageAttachments : undefined,
        prompt: canonicalDraft,
        ...patch,
      },
      {
        stickySettingsChanged: true,
      },
    );
    window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
  };

  const runThreadCodexEnvironmentAction = async (): Promise<void> => {
    if (
      !props.thread ||
      props.thread.source !== "codex" ||
      !props.desktopApi?.runCodexEnvironmentAction ||
      !selectedThreadCodexAction
    ) {
      return;
    }

    setSendError(undefined);
    props.onPendingStatusChange?.(`Starting ${selectedThreadCodexAction.name}`);
    try {
      await props.desktopApi.runCodexEnvironmentAction({
        backend: props.thread.source,
        threadId: props.thread.id,
        actionId: selectedThreadCodexAction.id,
        ...(workspaceOpenPath ? { cwd: workspaceOpenPath } : {}),
      });
      await props.onRefreshNavigation?.();
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      props.onPendingStatusChange?.(undefined);
    }
  };

  const setThreadCodexEnvironment = async (
    environmentId?: string,
  ): Promise<void> => {
    if (
      !props.thread ||
      props.thread.source !== "codex" ||
      !props.desktopApi?.setCodexThreadEnvironment
    ) {
      return;
    }

    setSendError(undefined);
    setSelectedThreadCodexActionId("");
    props.onPendingStatusChange?.(
      environmentId ? "Selecting Codex environment" : "Clearing Codex environment",
    );
    try {
      await props.desktopApi.setCodexThreadEnvironment({
        backend: props.thread.source,
        threadId: props.thread.id,
        environmentId,
      });
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      props.onPendingStatusChange?.(undefined);
    }
  };

  const applyExecutionModeSelection = (
    executionMode: ThreadExecutionMode,
  ): void => {
    if (props.launchpad) {
      if (props.launchpad.executionMode !== executionMode) {
        handleLaunchpadPatch({ executionMode });
      }
      return;
    }

    if (
      props.thread &&
      props.thread.executionMode !== executionMode &&
      !props.updatingExecutionMode
    ) {
      setSendError(undefined);
      void props.onSetExecutionMode?.(executionMode);
    }
  };

  const requestExecutionModeSelection = (
    executionMode: ThreadExecutionMode,
  ): void => {
    const currentExecutionMode =
      props.launchpad?.executionMode ?? props.thread?.executionMode ?? "default";
    if (
      currentExecutionMode === "default" &&
      executionMode === "full-access" &&
      !props.fullAccessRiskWarningDismissed
    ) {
      setFullAccessRiskDontWarnAgain(false);
      setFullAccessRiskError(undefined);
      setFullAccessRiskDialogOpen(true);
      return;
    }

    applyExecutionModeSelection(executionMode);
  };

  const confirmFullAccessRisk = async (): Promise<void> => {
    setFullAccessRiskSaving(true);
    setFullAccessRiskError(undefined);
    try {
      if (fullAccessRiskDontWarnAgain) {
        await props.onDismissFullAccessRiskWarning?.();
      }
      setFullAccessRiskDialogOpen(false);
      applyExecutionModeSelection("full-access");
    } catch (error) {
      setFullAccessRiskError(error instanceof Error ? error.message : String(error));
    } finally {
      setFullAccessRiskSaving(false);
    }
  };

  const handleThreadModelSettingsPatch = (
    patch: Partial<
      Pick<
      NavigationThreadSummary,
      "model" | "reasoningEffort" | "serviceTier" | "fastMode"
      >
    >
  ): void => {
    if (!props.thread || !props.onSetThreadModelSettings) {
      return;
    }

    setSendError(undefined);
    void props.onSetThreadModelSettings(patch);
  };

  const currentSettings = props.launchpad ?? props.thread;
  const modelOptions = backend?.launchpadOptions?.models ?? [];
  const selectedModelOption =
    modelOptions.find((option) => option.id === currentSettings?.model) ??
    getDefaultModelOption(backend);
  const supportsReasoning =
    selectedModelOption?.supportsReasoning ??
    Boolean(backend?.launchpadOptions?.reasoningEfforts?.length);
  const selectedReasoningEffort = supportsReasoning
    ? getReasoningEffortValue(backend, currentSettings?.reasoningEffort)
    : undefined;
  const supportsFast =
    backend?.kind === "codex"
      ? selectedModelOption?.supportsFast ??
        backend.launchpadOptions?.supportsFastMode ??
        false
      : false;
  const selectedServiceTier =
    currentSettings?.serviceTier ?? backend?.launchpadOptions?.serviceTiers?.[0];
  const providerOptions =
    props.backends?.filter(
      (candidate) => candidate.available && candidate.capabilities.createThread
    ) ?? [];
  const availableExecutionModes =
    backend?.executionModes.filter((mode) => mode.available) ?? [];
  const workspaceLabel = formatThreadWorkspaceLabel(props.thread);
  const supportsPlanMode =
    (props.launchpad?.backend ?? props.thread?.source) === "codex";
  const supportsSteering =
    Boolean(backend?.capabilities.steerTurn) &&
    selectedModelOption?.supportsSteering !== false &&
    props.thread?.source !== "grok";
  const launchpadSubmitting = isLaunchpad && sending;
  const launchpadWorkspaceOptions = props.launchpad
    ? buildLaunchpadWorkspaceOptions(props.launchpad, props.directory)
    : [];
  const launchpadWorkspaceValue =
    props.launchpad &&
    launchpadWorkspaceOptions.some((option) => option.value === props.launchpad?.workMode)
      ? props.launchpad.workMode
      : "local";
  const launchpadCodexEnvironmentOptions =
    props.launchpad?.backend === "codex"
      ? props.launchpad.codexEnvironmentOptions ?? []
      : [];
  const selectedCodexEnvironment = launchpadCodexEnvironmentOptions.find(
    (environment) => environment.id === props.launchpad?.codexEnvironmentId,
  );
  const threadCodexEnvironmentOptions =
    props.thread?.source === "codex"
      ? props.thread.codexEnvironmentOptions ?? []
      : [];
  const selectedThreadCodexEnvironmentOption = threadCodexEnvironmentOptions.find(
    (environment) =>
      environment.id === props.thread?.codexEnvironmentRuntime?.environmentId,
  );
  const runtimeThreadCodexEnvironmentActions =
    props.thread?.source === "codex"
      ? props.thread.codexEnvironmentRuntime?.actions ?? []
      : [];
  const threadCodexEnvironmentActions =
    runtimeThreadCodexEnvironmentActions.length > 0
      ? runtimeThreadCodexEnvironmentActions
      : selectedThreadCodexEnvironmentOption?.actions ?? [];
  const [selectedThreadCodexActionId, setSelectedThreadCodexActionId] =
    useState<string>("");
  const selectedThreadCodexAction =
    threadCodexEnvironmentActions.find(
      (action) => action.id === selectedThreadCodexActionId,
    ) ?? threadCodexEnvironmentActions[0];
  const threadWorkspace = props.thread ? getThreadWorkspace(props.thread) : undefined;
  const workspaceOpenPath = getComposerWorkspaceOpenPath({
    directory: props.directory,
    launchpad: props.launchpad,
    threadWorkspace,
  });
  const editorApplication = props.applications?.editors.find(
    (application) =>
      application.canOpenWorkspace &&
      application.id === props.applications?.preferredEditorId.value,
  ) ?? props.applications?.editors.find(
    (application) => application.canOpenWorkspace,
  );
  const terminalApplication = props.applications?.terminals.find(
    (application) =>
      application.canOpenWorkspace &&
      application.id === props.applications?.preferredTerminalId.value,
  ) ?? props.applications?.terminals.find(
    (application) => application.canOpenWorkspace,
  );
  const sourceBranch =
    threadWorkspace?.mode === "worktree"
      ? props.thread?.observedGitBranch ??
        props.thread?.gitBranch ??
        props.directory?.gitStatus?.currentBranch
      : props.directory?.gitStatus?.currentBranch ??
        props.thread?.observedGitBranch ??
        props.thread?.gitBranch;
  const branchOptions = getLeaveLocalBranchOptions({
    currentBranch: sourceBranch,
    directory: props.directory,
  });
  const canHandoffThreadWorkspace = Boolean(
    props.thread &&
      threadWorkspace &&
      props.onHandoffThreadWorkspace &&
      !sending &&
      !activeTurnId &&
      !props.pendingRequestActive &&
      !props.pendingUserInputActive &&
      !handoffSubmitting
  );

  useEffect(() => {
    if (activeTurnId) {
      setWorkspaceMenuOpen(false);
    }
  }, [activeTurnId]);

  const openHandoffDialog = (
    direction: HandoffThreadWorkspaceRequest["direction"]
  ): void => {
    setWorkspaceMenuOpen(false);
    setHandoffError(undefined);
    setHandoffDialog(direction);
    if (direction === "local-to-worktree") {
      setLocalHandoffStrategy("detached-changes");
      setLeaveLocalBranch(branchOptions[0] ?? "");
      setNewLocalBranch(buildHandoffBranchSuggestion(sourceBranch));
    }
  };

  const submitHandoff = async (): Promise<void> => {
    if (!threadWorkspace || !props.onHandoffThreadWorkspace) {
      return;
    }

    setHandoffSubmitting(true);
    setHandoffError(undefined);
    try {
      const handoffStrategy =
        handoffDialog === "local-to-worktree"
          ? localHandoffStrategy
          : undefined;
      await props.onHandoffThreadWorkspace({
        direction: handoffDialog!,
        ...(handoffStrategy ? { strategy: handoffStrategy } : {}),
        repositoryPath: threadWorkspace.repositoryPath,
        sourcePath: threadWorkspace.sourcePath,
        sourceBranch,
        ...(handoffDialog === "local-to-worktree" && handoffStrategy === "move-branch"
          ? { leaveLocalBranch: leaveLocalBranch || undefined }
          : {}),
        ...(handoffDialog === "local-to-worktree" && handoffStrategy === "new-branch"
          ? { newBranchName: newLocalBranch || undefined }
          : {}),
      });
      setHandoffDialog(undefined);
    } catch (error) {
      setHandoffError(error instanceof Error ? error.message : String(error));
    } finally {
      setHandoffSubmitting(false);
    }
  };

  const openWorkspaceApplication = async (
    application: DesktopApplicationDiscoveryCandidate,
  ): Promise<void> => {
    if (!props.desktopApi?.openApplication) {
      setApplicationOpenError("Desktop bridge is missing openApplication().");
      return;
    }
    if (!workspaceOpenPath) {
      setApplicationOpenError("No workspace path is available for this thread.");
      return;
    }

    setApplicationOpenError(undefined);
    try {
      await props.desktopApi.openApplication({
        applicationId: application.id,
        kind: application.kind,
        targetPath: workspaceOpenPath,
      });
    } catch (error) {
      setApplicationOpenError(error instanceof Error ? error.message : String(error));
    }
  };

  const handoffDisabled =
    handoffSubmitting ||
    !sourceBranch ||
    (handoffDialog === "local-to-worktree" &&
      ((localHandoffStrategy === "move-branch" && !leaveLocalBranch) ||
        (localHandoffStrategy === "new-branch" && !newLocalBranch.trim())));

  const commitActiveAutocomplete = (): void => {
    if (autocompleteKind === "skills") {
      applySkill(filteredSkills[activeSkillIndex] ?? filteredSkills[0]!);
      return;
    }

    applySlashCommand(
      filteredSlashCommands[activeSlashIndex] ?? filteredSlashCommands[0]!
    );
  };

  const restoreDeletedSkillToken = (
    event: ReactKeyboardEvent<HTMLElement>,
  ): boolean => {
    if (
      event.key.toLowerCase() !== "z" ||
      (!event.metaKey && !event.ctrlKey) ||
      event.shiftKey ||
      deletedSkillTokenHistoryRef.current.length === 0
    ) {
      return false;
    }

    const previous = deletedSkillTokenHistoryRef.current.pop()!;
    event.preventDefault();
    setDraft(previous.draft);
    setSkillTokens(previous.skillTokens);
    setEditorDocument(undefined);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(
        previous.selectionStart,
        previous.selectionStart,
      );
    });
    return true;
  };

  const handleAutocompleteKeyDown = (
    event: ReactKeyboardEvent<HTMLElement>,
  ): void => {
    if (!hasAutocomplete && event.key !== "Escape") {
      return;
    }

    const updateActiveAutocompleteIndex = (
      updater: (current: number) => number,
    ): void => {
      if (autocompleteKind === "skills") {
        setActiveSkillIndex(updater);
      } else {
        setActiveSlashIndex(updater);
      }
    };

    const getAutocompletePageStep = (): number => {
      const list = autocompleteListRef.current;
      const option = autocompleteOptionRefs.current.find(Boolean);
      const optionHeight = option?.getBoundingClientRect().height ?? 0;
      if (list && optionHeight > 0) {
        return Math.max(1, Math.floor(list.clientHeight / optionHeight));
      }
      return Math.max(1, Math.min(6, autocompleteLength - 1));
    };

    if (event.key === "ArrowDown") {
      event.preventDefault();
      updateActiveAutocompleteIndex((current) =>
        Math.min(current + 1, autocompleteLength - 1)
      );
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      updateActiveAutocompleteIndex((current) => Math.max(current - 1, 0));
      return;
    }

    if (event.key === "PageDown") {
      event.preventDefault();
      const pageStep = getAutocompletePageStep();
      updateActiveAutocompleteIndex((current) =>
        Math.min(current + pageStep, autocompleteLength - 1)
      );
      return;
    }

    if (event.key === "PageUp") {
      event.preventDefault();
      const pageStep = getAutocompletePageStep();
      updateActiveAutocompleteIndex((current) => Math.max(current - pageStep, 0));
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      if (autocompleteKey) {
        setDismissedAutocompleteKey(autocompleteKey);
      }
      setActiveSkillIndex(0);
      setActiveSlashIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }

    const optionHasFocus = event.currentTarget instanceof HTMLButtonElement;
    if (
      (event.key === "Tab" && !event.shiftKey) ||
      event.key === "Enter" ||
      (event.key === " " && optionHasFocus)
    ) {
      if (event.key === "Enter" && event.shiftKey) {
        return;
      }
      event.preventDefault();
      commitActiveAutocomplete();
    }
  };

  const composerDisabled =
    launchpadSubmitting || (props.disabled && !hasComposerContent);
  const composerPlaceholder = isLaunchpad
    ? `Start a new thread in ${props.launchpad?.directoryLabel ?? "this directory"}`
    : "Reply to this thread";
  const handleComposerChange = (
    nextDraft: string,
    nextSkillTokens?: ComposerSkillToken[],
    metadata?: ComposerInputChangeMetadata,
  ): void => {
    if (!recoveringDraftRef.current) {
      recoveryCycleRef.current = undefined;
      recoveryEligibilityVersionRef.current += 1;
    }
    unmarkComposerDraftSubmitted(composerScopeKey);
    const pendingProgrammaticChange =
      pendingProgrammaticComposerChangeRef.current;
    if (pendingProgrammaticChange && nextSkillTokens) {
      const nextSkillTokensSignature =
        getComposerSkillTokensSignature(nextSkillTokens);
      if (
        nextDraft === pendingProgrammaticChange.staleDraft &&
        nextSkillTokensSignature ===
          pendingProgrammaticChange.staleSkillTokensSignature
      ) {
        return;
      }
      pendingProgrammaticComposerChangeRef.current = undefined;
    }

    const deletedSkillTokenHistoryEntry =
      nextSkillTokens &&
      nextSkillTokens.length < skillTokens.length
        ? (() => {
            const nextTokenIds = new Set(
              nextSkillTokens.map((token) => token.id),
            );
            const deletedToken = skillTokens.find(
              (token) => !nextTokenIds.has(token.id),
            );
            return deletedToken
              ? {
                  draft,
                  selectionStart: deletedToken.index,
                  skillTokens,
                }
              : undefined;
          })()
        : undefined;
    const storedSkillTokens = nextSkillTokens ?? skillTokens;
    const preserveRecoveryCycle =
      !recoveringDraftRef.current &&
      recoveryCycleRef.current?.candidates.some(
        (candidate) =>
          getComposerDraftSnapshotSignature(candidate) ===
          getComposerDraftSnapshotSignature({
            draft: nextDraft,
            editorDocument: metadata?.editorDocument,
            imageAttachments,
            skillTokens: storedSkillTokens,
          }),
      ) === true;

    updateVisibleDraft(nextDraft, nextSkillTokens, { preserveRecoveryCycle });
    setEditorDocument(metadata?.editorDocument);
    saveComposerDraftSnapshot(composerScopeKey, {
      draft: nextDraft,
      editorDocument: metadata?.editorDocument,
      imageAttachments,
      skillTokens: storedSkillTokens,
    });
    if (deletedSkillTokenHistoryEntry) {
      deletedSkillTokenHistoryRef.current.push(deletedSkillTokenHistoryEntry);
    }
    if (nextDraft.trim() !== "/review") {
      setReviewConfig(undefined);
    }
    setSendError(undefined);
  };
  const handleComposerClick = (): void => {
    setActiveSkillIndex(0);
    setActiveSlashIndex(0);
  };
  const handlePlainComposerKeyDown = (
    event: ReactKeyboardEvent<HTMLElement>,
  ): void => {
    if (event.defaultPrevented) {
      return;
    }

    if (!hasAutocomplete) {
      const liveHasComposerContent = Boolean(
        (inputRef.current?.value ?? draft).trim() ||
          (inputRef.current?.skillTokenCount ?? skillTokens.length) > 0,
      );
      const liveHasAnyComposerContent =
        liveHasComposerContent || imageAttachments.length > 0;
      const recoveryCycle = recoveryCycleRef.current;
      const liveSelectionAtStart =
        (inputRef.current?.selectionStart ?? 0) === 0 &&
        (inputRef.current?.selectionEnd ?? 0) === 0;
      const canCycleActiveRecovery =
        recoveryCycle?.scopeKey === composerScopeKey && liveSelectionAtStart;
      if (recoveryCycle && !canCycleActiveRecovery) {
        recoveryCycleRef.current = undefined;
        recoveryEligibilityVersionRef.current += 1;
      }
      if (
        recoveryCycle &&
        canCycleActiveRecovery &&
        liveHasAnyComposerContent &&
        event.key !== "ArrowUp" &&
        event.key !== "ArrowDown"
      ) {
        recoveryCycleRef.current = undefined;
        recoveryEligibilityVersionRef.current += 1;
      }
      if (
        event.key === "ArrowUp" &&
        (!liveHasComposerContent || canCycleActiveRecovery) &&
        (imageAttachments.length === 0 || canCycleActiveRecovery)
      ) {
        event.preventDefault();
        void recoverPreviousComposerDraft();
        return;
      }
      if (
        event.key === "ArrowDown" &&
        liveHasAnyComposerContent &&
        canCycleActiveRecovery &&
        (imageAttachments.length === 0 || canCycleActiveRecovery)
      ) {
        event.preventDefault();
        recoverNextComposerDraft();
        return;
      }

      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void submitTurn(event.metaKey ? "steer" : "default");
      }
      return;
    }

    handleAutocompleteKeyDown(event);
  };
  const handleTiptapComposerKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ): void => {
    if (event.defaultPrevented) {
      return;
    }

    if (restoreDeletedSkillToken(event)) {
      return;
    }

    handlePlainComposerKeyDown(event);
  };

  const fullAccessRiskDialog = fullAccessRiskDialogOpen
    ? createPortal(
        <div className="full-access-warning-modal">
          <div
            aria-labelledby="full-access-warning-title"
            aria-modal="true"
            className="full-access-warning-dialog"
            role="dialog"
          >
            <div className="full-access-warning-dialog__header">
              <h2 id="full-access-warning-title">Enable Full Access?</h2>
              <button
                aria-label="Cancel Full Access warning"
                className="workspace-handoff-dialog__close"
                disabled={fullAccessRiskSaving}
                type="button"
                onClick={() => {
                  setFullAccessRiskDialogOpen(false);
                }}
              >
                ×
              </button>
            </div>
            <p>
              Full Access allows network access and read/write access to almost
              all files on this machine.
            </p>
            <p>
              That means data can be exfiltrated unintentionally, or by
              malicious code the agent downloads and executes through a supply
              chain attack on npm, PyPI, Rust crates, Go modules, or a similar
              dependency source.
            </p>
            <label className="composer__checkbox full-access-warning-dialog__checkbox">
              <input
                checked={fullAccessRiskDontWarnAgain}
                disabled={fullAccessRiskSaving}
                type="checkbox"
                onChange={(event) =>
                  setFullAccessRiskDontWarnAgain(event.currentTarget.checked)
                }
              />
              <span>Do not warn me again on this desktop.</span>
            </label>
            {fullAccessRiskError ? (
              <p className="full-access-warning-dialog__error" role="alert">
                {fullAccessRiskError}
              </p>
            ) : null}
            <div className="full-access-warning-dialog__actions">
              <button
                className="button button--secondary"
                disabled={fullAccessRiskSaving}
                type="button"
                onClick={() => {
                  setFullAccessRiskDialogOpen(false);
                }}
              >
                Cancel
              </button>
              <button
                className="button button--primary"
                disabled={fullAccessRiskSaving}
                type="button"
                onClick={() => {
                  void confirmFullAccessRisk();
                }}
              >
                I Understand and Accept the Risks
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;
  const workspaceHandoffDialog =
    handoffDialog && threadWorkspace
      ? createPortal(
          <div className="workspace-handoff-modal">
            <div
              aria-label={
                handoffDialog === "local-to-worktree"
                  ? "Handoff to New Worktree"
                  : "Handoff to Local"
              }
              aria-modal="true"
              className="workspace-handoff-dialog"
              role="dialog"
            >
              <h2>
                {handoffDialog === "local-to-worktree"
                  ? "Handoff to New Worktree"
                  : "Handoff to Local"}
              </h2>
              <p>
                {handoffDialog === "local-to-worktree"
                  ? "Choose how this thread should move into a new worktree."
                  : "Move this worktree branch back to Local. Dirty tracked and non-ignored files will be stashed and applied in Local, then the old worktree will be archived."}
              </p>
              <dl className="workspace-handoff-dialog__summary">
                <div>
                  <dt>
                    {handoffDialog === "worktree-to-local" && sourceBranch === "HEAD"
                      ? "Detached HEAD to move"
                      : handoffDialog === "local-to-worktree" &&
                          localHandoffStrategy === "detached-changes"
                        ? "Current branch"
                        : "Branch to move"}
                  </dt>
                  <dd>{sourceBranch ?? "Unknown branch"}</dd>
                </div>
              </dl>
              {handoffDialog === "local-to-worktree" ? (
                <>
                  <div
                    aria-label="Handoff strategy"
                    className="workspace-handoff-dialog__strategy-list"
                    role="radiogroup"
                  >
                    <button
                      aria-checked={localHandoffStrategy === "detached-changes"}
                      className="workspace-handoff-dialog__strategy"
                      disabled={handoffSubmitting}
                      role="radio"
                      type="button"
                      onClick={() => setLocalHandoffStrategy("detached-changes")}
                    >
                      <span className="workspace-handoff-dialog__strategy-title">
                        Handoff to Detached HEAD
                      </span>
                      <span>
                        Keep Local on the current branch. Create a detached worktree at
                        the current branch tip and move dirty non-ignored changes on top.
                      </span>
                    </button>
                    <button
                      aria-checked={localHandoffStrategy === "new-branch"}
                      className="workspace-handoff-dialog__strategy"
                      disabled={handoffSubmitting}
                      role="radio"
                      type="button"
                      onClick={() => setLocalHandoffStrategy("new-branch")}
                    >
                      <span className="workspace-handoff-dialog__strategy-title">
                        Handoff to New Branch
                      </span>
                      <span>
                        Keep Local on this branch. Create a named branch in the new
                        worktree and move dirty non-ignored changes on top.
                      </span>
                    </button>
                    <button
                      aria-checked={localHandoffStrategy === "move-branch"}
                      className="workspace-handoff-dialog__strategy"
                      disabled={handoffSubmitting || branchOptions.length === 0}
                      role="radio"
                      type="button"
                      onClick={() => setLocalHandoffStrategy("move-branch")}
                    >
                      <span className="workspace-handoff-dialog__strategy-title">
                        Handoff Current Branch
                      </span>
                      <span>
                        Move this branch into the new worktree, then switch this checkout to
                        a selected branch.
                      </span>
                    </button>
                  </div>
                  {localHandoffStrategy === "move-branch" ? (
                    <label className="workspace-handoff-dialog__field">
                      Leave current checkout on
                      <select
                        aria-label="Leave current checkout on"
                        className="composer__select"
                        disabled={handoffSubmitting || branchOptions.length === 0}
                        value={leaveLocalBranch}
                        onChange={(event) => setLeaveLocalBranch(event.target.value)}
                      >
                        {branchOptions.map((branch) => (
                          <option key={branch} value={branch}>
                            {formatLeaveLocalBranchOption(branch)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {localHandoffStrategy === "new-branch" ? (
                    <label className="workspace-handoff-dialog__field">
                      New branch name
                      <input
                        aria-label="New branch name"
                        className="workspace-handoff-dialog__text-input"
                        disabled={handoffSubmitting}
                        spellCheck={false}
                        type="text"
                        value={newLocalBranch}
                        onChange={(event) => setNewLocalBranch(event.target.value)}
                      />
                    </label>
                  ) : null}
                </>
              ) : null}
              {handoffDialog === "local-to-worktree" &&
              localHandoffStrategy === "move-branch" &&
              branchOptions.length === 0 ? (
                <p className="workspace-handoff-dialog__note">
                  No available local branch can be checked out before moving this branch.
                </p>
              ) : null}
              {handoffDialog === "local-to-worktree" &&
              localHandoffStrategy === "detached-changes" ? (
                <p className="workspace-handoff-dialog__note">
                  The new worktree starts at the current tip of{" "}
                  {sourceBranch ?? "this branch"} and receives dirty non-ignored changes on
                  top.
                </p>
              ) : null}
              {handoffDialog === "local-to-worktree" &&
              localHandoffStrategy === "new-branch" ? (
                <p className="workspace-handoff-dialog__note">
                  The new worktree creates{" "}
                  {newLocalBranch.trim() ? (
                    <code>{newLocalBranch.trim()}</code>
                  ) : (
                    "a named branch"
                  )}{" "}
                  at the current tip of {sourceBranch ?? "this branch"} and receives
                  dirty non-ignored changes on top.
                </p>
              ) : null}
              <p className="workspace-handoff-dialog__note">
                Ignored files are not moved by handoff.
              </p>
              {handoffError ? (
                <p className="workspace-handoff-dialog__error">{handoffError}</p>
              ) : null}
              <div className="workspace-handoff-dialog__actions">
                <button
                  className="button button--ghost"
                  disabled={handoffSubmitting}
                  type="button"
                  onClick={() => setHandoffDialog(undefined)}
                >
                  Cancel
                </button>
                <button
                  className="button button--primary"
                  disabled={handoffDisabled}
                  type="button"
                  onClick={() => {
                    void submitHandoff();
                  }}
                >
                  {handoffSubmitting ? "Handing off..." : "Handoff"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <form
        className="composer"
        data-composer-implementation="tiptap-wysiwyg-markdown-chips"
        onSubmit={(event) => {
          event.preventDefault();
          void submitTurn();
        }}
      >
        {/* Issue #240: removed the visible "Reply" / "New thread" /
          "Review" eyebrow that used to sit above the composer. The
          input itself carries the same name through its `aria-label`
          (the `label` prop on the inner ComposerRichInput /
          ComposerTiptapInput / ComposerTextareaInput is rendered as
          the input's `aria-label`), and the placeholder text already
          conveys the action prompt visually. Stacking another header
          above an input that already names itself was redundant
          chrome. */}

      <EnvActionAnchorList runtime={props.thread?.codexEnvironmentRuntime} />

      {pendingSteer ? (
        <div
          className="composer__queued composer__queued--steer"
          aria-label="Pending steer message"
        >
          <div className="composer__queued-copy">
            <span className="composer__queued-label">
              {pendingSteer.status === "steering" ? "Steering now" : "Pending steer"}
            </span>
            <span className="composer__queued-text">
              {formatDraftPreview(pendingSteer)}
            </span>
          </div>
          <QueuedImageAttachments attachments={pendingSteer.imageAttachments} />
          <div className="composer__queued-actions">
            {pendingSteer.status === "pending" ? (
              <>
                <button
                  className="composer__secondary-action"
                  type="button"
                  onClick={() => {
                    setComposerDraftFromCanonical(pendingSteer.text);
                    setImageAttachments(pendingSteer.imageAttachments);
                    setPendingSteer(undefined);
                    requestAnimationFrame(() => inputRef.current?.focus());
                  }}
                >
                  Edit
                </button>
                <button
                  className="composer__secondary-action"
                  type="button"
                  onClick={() => {
                    setPendingSteer(undefined);
                  }}
                >
                  Delete
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {props.thread?.queuedExecutionMode &&
      props.thread.queuedExecutionMode !== props.thread.executionMode ? (
        <div
          className="composer__queued composer__queued--permissions"
          aria-label="Queued permissions change"
        >
          <div className="composer__queued-copy">
            <span className="composer__queued-label">Permissions queued</span>
            <span className="composer__queued-text">
              Will switch to{" "}
              {formatExecutionModeLabel(props.thread.queuedExecutionMode)} when
              the current turn ends
            </span>
          </div>
          <div className="composer__queued-actions">
            <button
              className="composer__secondary-action"
              type="button"
              disabled={!props.onCancelExecutionModeQueue}
              onClick={() => {
                void props.onCancelExecutionModeQueue?.();
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {queuedTurns.map((queued, index) => (
        <div
          className="composer__queued"
          aria-label={index === 0 ? "Queued message" : `Queued message ${index + 1}`}
          key={`${index}:${queued.text}:${queued.imageAttachments.length}`}
        >
          <div className="composer__queued-copy">
            <span className="composer__queued-label">
              {index === 0 ? "Queued next" : `Queued #${index + 1}`}
            </span>
            <span className="composer__queued-text">
              {formatDraftPreview(queued)}
            </span>
          </div>
          <QueuedImageAttachments attachments={queued.imageAttachments} />
          <div className="composer__queued-actions">
            {supportsSteering && !queued.reviewCommand ? (
              <button
                className="composer__secondary-action"
                disabled={props.disabled || steering || !activeTurnId}
                type="button"
                onClick={() => {
                  steerQueuedTurn(queued);
                }}
              >
                {steering ? "Steering..." : "Steer"}
              </button>
            ) : null}
            <button
              className="composer__secondary-action"
              type="button"
              onClick={() => {
                setComposerDraftFromCanonical(queued.text);
                setImageAttachments(queued.imageAttachments);
                removeQueuedTurnAt(index);
                requestAnimationFrame(() => inputRef.current?.focus());
              }}
            >
              Edit
            </button>
            <button
              className="composer__secondary-action"
              type="button"
              onClick={() => {
                removeQueuedTurnAt(index);
              }}
            >
              Delete
            </button>
          </div>
        </div>
      ))}

      <div className="composer__input-wrap" ref={inputWrapRef}>
        {isReviewComposerOpen ? (
          <fieldset className="composer__review-config" aria-label="Review target">
            <legend>Review target</legend>
            <div className="composer__review-options">
              {REVIEW_TARGET_OPTIONS.map((option) => (
                <button
                  key={option.target}
                  type="button"
                  aria-pressed={reviewConfig?.target === option.target}
                  className={`composer__review-option${reviewConfig?.target === option.target ? " is-active" : ""}`}
                  onClick={() => {
                    setReviewConfig((current) => ({
                      ...(current ??
                        createReviewConfig({
                          directory: props.directory,
                          thread: props.thread,
                        })),
                      target: option.target,
                    }));
                    setSendError(undefined);
                  }}
                >
                  <span>{option.label}</span>
                  <small>{option.description}</small>
                </button>
              ))}
            </div>

            {reviewConfig?.target === "baseBranch" ? (
              <label className="composer__review-field">
                <span>Base branch</span>
                <input
                  className="composer__review-input"
                  list="composer-review-branches"
                  value={reviewConfig.branch}
                  onChange={(event) => {
                    setReviewConfig((current) => ({
                      ...(current ??
                        createReviewConfig({
                          directory: props.directory,
                          thread: props.thread,
                        })),
                      branch: event.target.value,
                      target: "baseBranch",
                    }));
                    setSendError(undefined);
                  }}
                />
                {reviewBranchOptions.length > 0 ? (
                  <datalist id="composer-review-branches">
                    {reviewBranchOptions.map((branch) => (
                      <option key={branch} value={branch} />
                    ))}
                  </datalist>
                ) : null}
              </label>
            ) : null}

            {reviewConfig?.target === "commit" ? (
              <label className="composer__review-field">
                <span>Commit SHA</span>
                <input
                  className="composer__review-input"
                  value={reviewConfig.commit}
                  onChange={(event) => {
                    setReviewConfig((current) => ({
                      ...(current ??
                        createReviewConfig({
                          directory: props.directory,
                          thread: props.thread,
                        })),
                      commit: event.target.value,
                      target: "commit",
                    }));
                    setSendError(undefined);
                  }}
                />
              </label>
            ) : null}

            {reviewConfig?.target === "custom" ? (
              <label className="composer__review-field">
                <span>Instructions</span>
                <textarea
                  className="composer__review-input composer__review-input--textarea"
                  value={reviewConfig.customInstructions}
                  onChange={(event) => {
                    setReviewConfig((current) => ({
                      ...(current ??
                        createReviewConfig({
                          directory: props.directory,
                          thread: props.thread,
                        })),
                      customInstructions: event.target.value,
                      target: "custom",
                    }));
                    setSendError(undefined);
                  }}
                />
              </label>
            ) : null}

            <div className="composer__review-actions">
              <button
                type="button"
                className="composer__secondary-action"
                onClick={exitReviewComposer}
              >
                Cancel
              </button>
              <button
                type="button"
                className="composer__primary-action"
                disabled={!buildConfiguredReviewCommand(reviewConfig)}
                onClick={() => {
                  const configuredReviewCommand =
                    buildConfiguredReviewCommand(reviewConfig);
                  if (!configuredReviewCommand) {
                    return;
                  }
                  void submitReviewCommand(configuredReviewCommand);
                }}
              >
                Start review
              </button>
            </div>
          </fieldset>
        ) : (
          <ComposerTiptapInput
            ref={inputRef}
            id="thread-composer"
            ariaActiveDescendant={activeAutocompleteOptionId}
            ariaControls={autocompleteListboxId}
            ariaExpanded={hasAutocomplete}
            disabled={composerDisabled}
            label={isLaunchpad ? "New thread" : "Reply"}
            markdownConversion
            placeholder={composerPlaceholder}
            selectionRequest={composerSelectionRequest}
            editorDocument={editorDocument}
            skillTokens={skillTokens}
            value={draft}
            onChange={handleComposerChange}
            onPaste={handlePaste}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onClick={handleComposerClick}
            onKeyDown={handleTiptapComposerKeyDown}
          />
        )}

        {autocompleteKind === "skills" ? (
          <div
            className={`composer__autocomplete composer__autocomplete--${autocompleteLayout.placement}`}
            ref={autocompleteListRef}
            role="listbox"
            aria-label="Skills"
            id={skillListboxId}
            style={{ maxHeight: autocompleteLayout.maxHeight }}
          >
            {filteredSkills.map((skill, index) => (
              <button
                key={skill.path ?? skill.name}
                id={`${skillListboxId}-option-${index}`}
                ref={(node) => {
                  autocompleteOptionRefs.current[index] = node;
                }}
                aria-selected={index === activeSkillIndex}
                className={`composer__autocomplete-option${index === activeSkillIndex ? " is-active" : ""}`}
                tabIndex={index === activeSkillIndex ? 0 : -1}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  applySkill(skill);
                }}
                onClick={() => {
                  applySkill(skill);
                }}
                onFocus={() => {
                  setActiveSkillIndex(index);
                }}
                onKeyDown={handleAutocompleteKeyDown}
              >
                <span className="composer__autocomplete-title">
                  <span aria-hidden="true">🧰</span>
                  <HighlightedAutocompleteLabel
                    label={`$${skill.name}`}
                    query={trigger?.query ? `$${trigger.query}` : "$"}
                  />
                </span>
                <span className="composer__autocomplete-meta">
                  {skill.shortDescription || skill.description || skill.path}
                </span>
              </button>
            ))}
          </div>
        ) : autocompleteKind === "slash" ? (
          <div
            className={`composer__autocomplete composer__autocomplete--${autocompleteLayout.placement}`}
            ref={autocompleteListRef}
            role="listbox"
            aria-label="Commands"
            id={slashListboxId}
            style={{ maxHeight: autocompleteLayout.maxHeight }}
          >
            {filteredSlashCommands.map((command, index) => (
              <button
                key={command.id}
                id={`${slashListboxId}-option-${index}`}
                ref={(node) => {
                  autocompleteOptionRefs.current[index] = node;
                }}
                aria-selected={index === activeSlashIndex}
                className={`composer__autocomplete-option${index === activeSlashIndex ? " is-active" : ""}`}
                tabIndex={index === activeSlashIndex ? 0 : -1}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  applySlashCommand(command);
                }}
                onClick={() => {
                  applySlashCommand(command);
                }}
                onFocus={() => {
                  setActiveSlashIndex(index);
                }}
                onKeyDown={handleAutocompleteKeyDown}
              >
                <span className="composer__autocomplete-title">
                  <span className="composer__autocomplete-token" aria-hidden="true">/</span>
                  <HighlightedAutocompleteLabel
                    label={command.label}
                    query={slashTrigger
                      ? draft.slice(slashTrigger.start, slashTrigger.end).trim()
                      : "/"}
                  />
                </span>
                <span className="composer__autocomplete-meta">
                  {command.description}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {imageAttachments.length > 0 ? (
        <div className="composer__attachments" aria-label="Pasted images">
          {imageAttachments.map((attachment, index) => (
            <div className="composer__attachment" key={attachment.id}>
              <img
                className="composer__attachment-preview"
                src={attachment.url}
                alt={formatPastedImageAlt(attachment, index)}
              />
              <div className="composer__attachment-copy">
                <span className="composer__attachment-name">
                  {attachment.name}
                </span>
                <span className="composer__attachment-meta">
                  {formatImageType(attachment.type)} · {formatBytes(attachment.size)}
                </span>
              </div>
              <button
                aria-label={`Remove ${attachment.name}`}
                className="composer__attachment-remove"
                type="button"
                onClick={() => {
                  removeImageAttachment(attachment.id);
                }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {props.launchpad || props.thread ? (
        <div
          className="composer__setup"
          aria-label={props.launchpad ? "New thread settings" : "Thread settings"}
        >
          {props.launchpad && providerOptions.length > 0 ? (
            <ComposerDropdown
              id="composer-provider"
              ariaLabel="Provider"
              disabled={launchpadSubmitting}
              value={props.launchpad.backend}
              options={providerOptions.map((candidate) => ({
                label: formatBackendLabel(candidate.kind),
                value: candidate.kind,
              }))}
              onChange={(value) => {
                const currentLaunchpad = props.launchpad;
                if (!currentLaunchpad) {
                  return;
                }
                const nextBackend = value as NavigationLaunchpadDraft["backend"];
                const nextBackendSummary = props.backends?.find(
                  (candidate) => candidate.kind === nextBackend
                );
                const executionModeStillAvailable = nextBackendSummary?.executionModes.some(
                  (mode) => mode.available && mode.mode === currentLaunchpad.executionMode
                );
                const nextModelOption = getDefaultModelOption(nextBackendSummary);
                handleLaunchpadPatch({
                  backend: nextBackend,
                  executionMode: executionModeStillAvailable
                    ? currentLaunchpad.executionMode
                    : "default",
                  model: nextModelOption?.id,
                  reasoningEffort: nextModelOption?.supportsReasoning
                    ? getDefaultReasoningEffort(nextBackendSummary)
                    : undefined,
                  serviceTier: undefined,
                  fastMode: undefined,
                  codexEnvironmentId: undefined,
                  codexEnvironmentExecutionTarget: undefined,
                  codexEnvironmentSetupEnabled: false,
                  codexEnvironmentActionId: undefined,
                });
              }}
            />
          ) : props.thread ? (
            <span className="composer__fixed-value" aria-label="Provider">
              {formatBackendLabel(props.thread.source)}
            </span>
          ) : null}

          {availableExecutionModes.length > 0 &&
          (props.launchpad || (props.thread?.source === "codex" && props.onSetExecutionMode)) ? (
            <ComposerDropdown
              ariaLabel="Access mode"
              compact
              disabled={launchpadSubmitting || Boolean(props.updatingExecutionMode)}
              value={
                props.launchpad?.executionMode ??
                props.thread?.executionMode ??
                "default"
              }
              options={availableExecutionModes.map((mode) => ({
                label: formatExecutionModeLabel(mode.mode),
                value: mode.mode,
              }))}
              onChange={(value) => {
                const executionMode = value as ThreadExecutionMode;
                requestExecutionModeSelection(executionMode);
              }}
            />
          ) : null}

          {props.launchpad &&
          (props.onSelectDirectoryFromPicker || props.onPickAndRegisterDirectory) ? (
            // Project picker (issue #223). Only render in the launchpad
            // surface — once a thread exists, the directory binding is
            // immutable. The current directory shows as the trigger
            // value when the launchpad is anchored to an actual
            // directory; the synthesized "workspace:new-thread"
            // launchpad reads as "No selected project" instead.
            <ProjectPicker
              value={
                props.directory && props.directory.kind === "directory"
                  ? props.directory
                  : undefined
              }
              directories={props.directories ?? []}
              disabled={launchpadSubmitting}
              pickError={props.pickDirectoryError}
              picking={props.pickingDirectory}
              onSelect={(directory) => {
                props.onClearPickDirectoryError?.();
                props.onSelectDirectoryFromPicker?.(directory);
              }}
              onPickFromDisk={() => {
                props.onClearPickDirectoryError?.();
                props.onPickAndRegisterDirectory?.();
              }}
            />
          ) : null}

          {props.launchpad ? (
            <ComposerDropdown
              ariaLabel="Workspace mode"
              compact
              disabled={
                launchpadSubmitting ||
                !props.onUpdateLaunchpad ||
                launchpadWorkspaceOptions.length <= 1
              }
              value={launchpadWorkspaceValue}
              options={launchpadWorkspaceOptions.map((option) => ({
                label: option.label,
                value: option.value,
              }))}
              onChange={(value) => {
                handleLaunchpadPatch({
                  workMode: value as NavigationLaunchpadDraft["workMode"],
                });
              }}
            />
          ) : workspaceLabel && threadWorkspace ? (
            <div className="composer-dropdown composer-dropdown--compact" ref={workspaceMenuRef}>
              <button
                aria-expanded={workspaceMenuOpen}
                aria-haspopup="menu"
                aria-label="Workspace mode"
                className="composer-dropdown__button"
                disabled={!canHandoffThreadWorkspace}
                type="button"
                value={threadWorkspace.mode}
                onClick={() => setWorkspaceMenuOpen((open) => !open)}
              >
                <span className="composer-dropdown__label">{workspaceLabel}</span>
                <span aria-hidden="true" className="composer-dropdown__chevron">
                  ⌄
                </span>
              </button>
              {workspaceMenuOpen ? (
                <div className="composer-dropdown__menu" role="menu">
                  <button className="composer-dropdown__option" disabled type="button">
                    <span aria-hidden="true" className="composer-dropdown__check">
                      ✓
                    </span>
                    {workspaceLabel}
                  </button>
                  <div className="composer-dropdown__separator" role="separator" />
                  <button
                    className="composer-dropdown__option"
                    disabled={!canHandoffThreadWorkspace}
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setWorkspaceMenuOpen(false);
                      openHandoffDialog(
                        threadWorkspace.mode === "worktree"
                          ? "worktree-to-local"
                          : "local-to-worktree"
                      );
                    }}
                  >
                    <span aria-hidden="true" className="composer-dropdown__check" />
                    {threadWorkspace.mode === "worktree"
                      ? "Handoff to Local"
                      : "Handoff to New Worktree"}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {props.launchpad &&
          launchpadWorkspaceValue === "worktree" &&
          (props.directory?.gitStatus?.branches?.length ?? 0) > 0 ? (
            <ComposerDropdown
              ariaLabel="Base branch"
              id="launchpad-branch"
              compact
              disabled={launchpadSubmitting}
              kind="branch"
              value={
                props.launchpad.branchName ??
                props.directory?.gitStatus?.currentBranch ??
                ""
              }
              options={(props.directory?.gitStatus?.branches ?? []).map((branch) => ({
                label: branch,
                value: branch,
              }))}
              onChange={(value) => {
                handleLaunchpadPatch({ branchName: value || undefined });
              }}
            />
          ) : null}

          {(props.launchpad || props.thread) && backend?.launchpadOptions?.models?.length ? (
            <ComposerDropdown
              id="composer-model"
              ariaLabel="Model"
              disabled={launchpadSubmitting}
              value={selectedModelOption?.id ?? ""}
              options={backend.launchpadOptions.models.map((model) => ({
                label: model.label ?? model.id,
                value: model.id,
              }))}
              onChange={(value) => {
                const model = value;
                const nextModelOption = backend.launchpadOptions?.models?.find(
                  (option) => option.id === model
                );
                const nextSupportsReasoning =
                  nextModelOption?.supportsReasoning ??
                  Boolean(backend.launchpadOptions?.reasoningEfforts?.length);
                const nextSupportsFast =
                  backend.kind === "codex"
                    ? nextModelOption?.supportsFast ??
                      backend.launchpadOptions?.supportsFastMode ??
                      false
                    : false;
                const patch = {
                  model,
                  reasoningEffort: nextSupportsReasoning
                    ? getReasoningEffortValue(backend, currentSettings?.reasoningEffort)
                    : undefined,
                  ...(nextSupportsFast ? {} : { fastMode: undefined }),
                };
                if (props.launchpad) {
                  handleLaunchpadPatch(patch);
                  return;
                }
                handleThreadModelSettingsPatch(patch);
              }}
            />
          ) : null}

          {(props.launchpad || props.thread) &&
          supportsReasoning &&
          backend?.launchpadOptions?.reasoningEfforts?.length ? (
            <ComposerDropdown
              id="composer-reasoning"
              ariaLabel="Reasoning"
              disabled={launchpadSubmitting}
              value={selectedReasoningEffort ?? ""}
              options={backend.launchpadOptions.reasoningEfforts.map((effort) => ({
                label: effort,
                value: effort,
              }))}
              onChange={(value) => {
                const reasoningEffort = value;
                if (props.launchpad) {
                  handleLaunchpadPatch({ reasoningEffort });
                  return;
                }
                handleThreadModelSettingsPatch({ reasoningEffort });
              }}
            />
          ) : null}

          {(props.launchpad || props.thread) && backend?.launchpadOptions?.serviceTiers?.length ? (
            <ComposerDropdown
              id="composer-service-tier"
              ariaLabel="Service tier"
              disabled={launchpadSubmitting}
              value={selectedServiceTier ?? ""}
              options={backend.launchpadOptions.serviceTiers.map((tier) => ({
                label: tier,
                value: tier,
              }))}
              onChange={(value) => {
                const serviceTier = value;
                if (props.launchpad) {
                  handleLaunchpadPatch({ serviceTier });
                  return;
                }
                handleThreadModelSettingsPatch({ serviceTier });
              }}
            />
          ) : null}

          {(props.launchpad || props.thread) && supportsFast ? (
            <label className="composer__checkbox">
              <input
                checked={Boolean(currentSettings?.fastMode)}
                disabled={launchpadSubmitting}
                type="checkbox"
                onChange={(event) => {
                  if (props.launchpad) {
                    handleLaunchpadPatch({ fastMode: event.target.checked });
                    return;
                  }
                  handleThreadModelSettingsPatch({ fastMode: event.target.checked });
                }}
              />
              <span>Fast mode</span>
            </label>
          ) : null}

          {supportsPlanMode ? (
            <label className="composer__checkbox">
              <input
                checked={planModeEnabled}
                disabled={sending}
                type="checkbox"
                onChange={(event) => {
                  setPlanModeEnabled(event.target.checked);
                }}
              />
              <span>Plan mode</span>
            </label>
          ) : null}
        </div>
      ) : null}

      {workspaceHandoffDialog}

      {props.skillError ? <p className="composer__meta composer__meta--error">{props.skillError}</p> : null}
      {props.launchpadError ? (
        <CopyableComposerError
          desktopApi={props.desktopApi}
          label="Copy launchpad error"
          text={props.launchpadError}
        />
      ) : null}
      {sendError ? <p className="composer__meta composer__meta--error">{sendError}</p> : null}
      {applicationOpenError ? (
        <p className="composer__meta composer__meta--error">{applicationOpenError}</p>
      ) : null}
      {props.setExecutionModeError ? (
        <p className="composer__meta composer__meta--error">
          {props.setExecutionModeError}
        </p>
      ) : null}
      {props.threadModelSettingsError ? (
        <p className="composer__meta composer__meta--error">
          {props.threadModelSettingsError}
        </p>
      ) : null}
      {!props.skillError && props.skillLoading ? (
        <p className="composer__meta">Loading skills…</p>
      ) : null}
      {props.launchpad &&
      launchpadSubmitting &&
      props.launchpad.codexEnvironmentId &&
      props.launchpad.codexEnvironmentSetupEnabled ? (
        <p className="composer__meta">Running environment setup…</p>
      ) : null}
      {props.updatingExecutionMode ? (
        <p className="composer__meta">
          Switching to {formatExecutionModeLabel(props.updatingExecutionMode)}…
        </p>
      ) : null}
      {props.disabled ? (
        <p className="composer__meta">
          {props.launchpad
            ? "This backend is unavailable right now. Your draft stays here until send is available again."
            : "This thread's backend is unavailable right now. You can keep drafting, but send is unavailable."}
        </p>
      ) : props.pendingRequestActive ? (
        <p className="composer__meta">
          Waiting for approval before this turn can continue.
        </p>
      ) : props.pendingUserInputActive ? (
        <p className="composer__meta">
          Waiting for input before this turn can continue.
        </p>
      ) : null}

      <div className="composer__footer">
        {launchpadCodexEnvironmentOptions.length > 0 ||
        threadCodexEnvironmentOptions.length > 0 ||
        props.thread?.codexEnvironmentRuntime ||
        (workspaceOpenPath && (editorApplication || terminalApplication)) ? (
          <div className="composer__application-actions" aria-label="Composer tools">
            {props.launchpad && launchpadCodexEnvironmentOptions.length > 0 ? (
              <ComposerDropdown
                ariaLabel="Codex environment"
                compact
                disabled={launchpadSubmitting}
                icon={FileCodeIcon}
                value={props.launchpad.codexEnvironmentId ?? ""}
                options={[
                  { label: "No environment", value: "" },
                  ...launchpadCodexEnvironmentOptions.map((environment) => ({
                    label: environment.name,
                    value: environment.id,
                  })),
                ]}
                onChange={(value) => {
                  const environment = launchpadCodexEnvironmentOptions.find(
                    (candidate) => candidate.id === value,
                  );
                  handleLaunchpadPatch({
                    codexEnvironmentId: environment?.id,
                    codexEnvironmentExecutionTarget: environment
                      ? props.launchpad?.codexEnvironmentExecutionTarget ?? "local"
                      : undefined,
                    codexEnvironmentSetupEnabled: Boolean(
                      environment?.setupScript,
                    ),
                    codexEnvironmentActionId: undefined,
                  });
                }}
              />
            ) : null}

            {props.launchpad && selectedCodexEnvironment?.setupScript ? (
              <label className="composer__checkbox">
                <input
                  checked={Boolean(props.launchpad.codexEnvironmentSetupEnabled)}
                  disabled={launchpadSubmitting}
                  type="checkbox"
                  onChange={(event) => {
                    handleLaunchpadPatch({
                      codexEnvironmentSetupEnabled: event.target.checked,
                    });
                  }}
                />
                <span>Run setup</span>
              </label>
            ) : null}

            {!props.launchpad && threadCodexEnvironmentOptions.length > 0 ? (
              <ComposerDropdown
                ariaLabel="Codex environment"
                compact
                disabled={!props.desktopApi?.setCodexThreadEnvironment}
                icon={FileCodeIcon}
                value={props.thread?.codexEnvironmentRuntime?.environmentId ?? ""}
                options={[
                  { label: "No environment", value: "" },
                  ...threadCodexEnvironmentOptions.map((environment) => ({
                    label: environment.name,
                    value: environment.id,
                  })),
                ]}
                onChange={(value) => {
                  void setThreadCodexEnvironment(value || undefined);
                }}
              />
            ) : null}

            {props.thread?.codexEnvironmentRuntime ? (
              <>
                <ComposerDropdown
                  ariaLabel="Environment command"
                  compact
                  disabled={
                    threadCodexEnvironmentActions.length === 0 ||
                    !props.desktopApi?.runCodexEnvironmentAction
                  }
                  value={selectedThreadCodexAction?.id ?? ""}
                  options={
                    threadCodexEnvironmentActions.length > 0
                      ? threadCodexEnvironmentActions.map((action) => ({
                          label: action.name,
                          value: action.id,
                        }))
                      : [{ label: "No commands", value: "" }]
                  }
                  onChange={(value) => {
                    setSelectedThreadCodexActionId(value);
                  }}
                />
                <button
                  className="composer__action-button"
                  disabled={
                    !selectedThreadCodexAction ||
                    !props.desktopApi?.runCodexEnvironmentAction
                  }
                  type="button"
                  onClick={() => {
                    void runThreadCodexEnvironmentAction();
                  }}
                >
                  Run
                </button>
              </>
            ) : null}

            {workspaceOpenPath && editorApplication ? (
              <ComposerApplicationButton
                application={editorApplication}
                label={editorApplication.name}
                onOpen={openWorkspaceApplication}
              />
            ) : null}
            {workspaceOpenPath && terminalApplication ? (
              <ComposerApplicationButton
                application={terminalApplication}
                label={terminalApplication.name}
                onOpen={openWorkspaceApplication}
              />
            ) : null}
          </div>
        ) : (
          <span aria-hidden="true" className="composer__footer-spacer" />
        )}

        <div className="composer__actions">
          <ContextWindowMoon contextWindow={props.contextWindow} />
          {activeTurnId ? (
            <button
              className="button button--ghost"
              disabled={props.disabled || interrupting}
              type="button"
              onClick={() => {
                void stopTurn();
              }}
            >
              {interrupting ? "Stopping…" : "Stop"}
            </button>
          ) : null}
          <button
            className="button button--primary"
            disabled={
              props.disabled ||
              steering ||
              (!activeTurnId && sending) ||
              (!hasComposerContent && imageAttachments.length === 0)
            }
            type="submit"
          >
            {activeTurnId
              ? "Queue"
              : sending
              ? props.launchpad
                ? "Starting…"
                : "Sending…"
              : props.launchpad
                ? "Start thread"
                : "Send"}
          </button>
        </div>
      </div>
      </form>
      {fullAccessRiskDialog}
    </>
  );
}

function ContextWindowMoon({
  contextWindow,
}: {
  contextWindow?: ThreadContextWindowState;
}) {
  if (!contextWindow) {
    return null;
  }

  const phase = Math.min(CONTEXT_MOON_PHASES.length - 1, Math.max(0, contextWindow.phase));
  const phaseLabel = CONTEXT_MOON_PHASES[phase];
  const percentLabel = `${Math.round(contextWindow.usedPercent)}%`;
  const tokenLabel = `${formatCompactNumber(
    contextWindow.totalTokens
  )}/${formatCompactNumber(contextWindow.modelContextWindow)}`;
  const label = `Context window ${percentLabel} full, ${tokenLabel} tokens, ${phaseLabel}`;
  const tooltip = buildContextWindowTooltip(contextWindow, phaseLabel);

  return (
    <div
      aria-label={label}
      className="context-window-moon tooltip-target"
      data-tooltip={tooltip}
      role="img"
      tabIndex={0}
    >
      <span
        aria-hidden="true"
        className={`context-window-moon__sprite context-window-moon__sprite--phase-${phase}`}
      >
        <span className="context-window-moon__disc" />
      </span>
      <span className="context-window-moon__label">{percentLabel}</span>
    </div>
  );
}

function buildContextWindowTooltip(
  contextWindow: ThreadContextWindowState,
  phaseLabel: string
): string {
  const lines = [
    `Context window: ${Math.round(contextWindow.usedPercent)}% full (${phaseLabel})`,
    `Current snapshot: ${formatCompactNumber(contextWindow.totalTokens)} / ${formatCompactNumber(
      contextWindow.modelContextWindow
    )} tokens`,
  ];

  if (typeof contextWindow.remainingTokens === "number") {
    const remainingPercent =
      typeof contextWindow.remainingPercent === "number"
        ? `, ${Math.round(contextWindow.remainingPercent)}% remaining`
        : "";
    lines.push(
      `Remaining: ${formatCompactNumber(contextWindow.remainingTokens)} tokens${remainingPercent}`
    );
  }

  const breakdown = [
    formatOptionalTokenDetail("input", contextWindow.inputTokens),
    formatCachedTokenDetail(contextWindow.cachedInputTokens, contextWindow.inputTokens),
    formatOptionalTokenDetail("output", contextWindow.outputTokens),
    formatOptionalTokenDetail("reasoning", contextWindow.reasoningOutputTokens),
  ].filter((detail): detail is string => Boolean(detail));

  if (breakdown.length > 0) {
    lines.push(`Current breakdown: ${breakdown.join(", ")}`);
  }

  if (typeof contextWindow.cumulativeTotalTokens === "number") {
    lines.push(
      `Cumulative usage reported: ${formatCompactNumber(
        contextWindow.cumulativeTotalTokens
      )} tokens`
    );
    const cumulativeCachedInput = formatCachedInputSummary(
      contextWindow.cumulativeCachedInputTokens,
      contextWindow.cumulativeInputTokens
    );
    if (cumulativeCachedInput) {
      lines.push(`Cumulative cached input: ${cumulativeCachedInput}`);
    }
  }

  return lines.join("\n");
}

function formatOptionalTokenDetail(label: string, value: number | undefined): string | undefined {
  return typeof value === "number" ? `${formatCompactNumber(value)} ${label}` : undefined;
}

function formatCachedTokenDetail(
  cachedInputTokens: number | undefined,
  inputTokens: number | undefined
): string | undefined {
  if (typeof cachedInputTokens !== "number") {
    return undefined;
  }

  const percent = formatCachedInputPercent(cachedInputTokens, inputTokens);
  return `${formatCompactNumber(cachedInputTokens)} cached${percent ? ` (${percent})` : ""}`;
}

function formatCachedInputSummary(
  cachedInputTokens: number | undefined,
  inputTokens: number | undefined
): string | undefined {
  if (typeof cachedInputTokens !== "number") {
    return undefined;
  }

  const percent = formatCachedInputPercent(cachedInputTokens, inputTokens);
  return `${formatCompactNumber(cachedInputTokens)}${percent ? ` (${percent})` : ""}`;
}

function formatCachedInputPercent(
  cachedInputTokens: number,
  inputTokens: number | undefined
): string | undefined {
  if (typeof inputTokens !== "number" || inputTokens <= 0) {
    return undefined;
  }

  const percent = Math.max(0, Math.min(100, (cachedInputTokens / inputTokens) * 100));
  return formatPercent(percent);
}

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) {
    return `${Math.round(value / 100_000) / 10}M`;
  }

  if (value >= 1_000) {
    return `${Math.round(value / 100) / 10}k`;
  }

  return String(Math.round(value));
}

function getImageFilesFromDataTransfer(dataTransfer: DataTransfer): ComposerImageFile[] {
  const files: ComposerImageFile[] = [];
  const seenFiles = new Set<string>();
  let foundImageItem = false;

  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== "file") {
      continue;
    }

    const file = item.getAsFile();
    if (!file) {
      continue;
    }

    const type = isImageMimeType(item.type) ? item.type : inferTransferImageType(file);
    if (!type) {
      continue;
    }

    foundImageItem = true;
    const key = buildFileKey(file);
    if (!seenFiles.has(key)) {
      files.push({ file, type });
      seenFiles.add(key);
    }
  }

  if (foundImageItem) {
    return files;
  }

  for (const file of Array.from(dataTransfer.files)) {
    const type = inferTransferImageType(file);
    if (!type) {
      continue;
    }

    const key = buildFileKey(file);
    if (!seenFiles.has(key)) {
      files.push({ file, type });
      seenFiles.add(key);
    }
  }

  return files;
}

function hasImageFiles(dataTransfer: DataTransfer): boolean {
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind === "file" && (!item.type || isImageMimeType(item.type))) {
      return true;
    }
  }

  return Array.from(dataTransfer.files).some((file) => Boolean(inferTransferImageType(file)));
}

function buildFileKey(file: File): string {
  return `${file.name}:${file.type}:${file.size}:${file.lastModified}`;
}

function inferTransferImageType(file: File): string | undefined {
  if (isImageMimeType(file.type)) {
    return file.type;
  }

  const extension = file.name.toLowerCase().split(".").pop();
  return extension === "gif" ? "image/gif" : undefined;
}

function isImageMimeType(type: string): boolean {
  return type.toLowerCase().startsWith("image/");
}

function isGifFile(file: File, type: string): boolean {
  return inferTransferImageType(file) === "image/gif" || type.toLowerCase() === "image/gif";
}

function readFileAsImageDataUrl(file: File, mimeType: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        if (reader.result.startsWith(`data:${mimeType}`)) {
          resolve(reader.result);
          return;
        }
        if (/^data:[^,]*,/i.test(reader.result)) {
          resolve(reader.result.replace(/^data:[^,]*,/i, `data:${mimeType};base64,`));
          return;
        }
      }
      reject(new Error("The image did not produce an image data URL."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("The image could not be read."));
    });
    reader.readAsDataURL(file);
  });
}

function formatPastedImageName(type: string, index: number): string {
  const extension = type.split("/")[1] || "png";
  return `pasted-image-${index + 1}.${extension}`;
}

function formatPastedImageAlt(
  attachment: Pick<ComposerImageAttachment, "name">,
  index: number
): string {
  return attachment.name || `Pasted image ${index + 1}`;
}

function formatImageType(type: string): string {
  const subtype = type.split("/")[1];
  return subtype ? subtype.toUpperCase() : "Image";
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) {
    return "Unknown size";
  }

  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }

  const mib = size / (1024 * 1024);
  if (mib < 10) {
    return `${Number(mib.toFixed(1))} MB`;
  }

  return `${Math.round(mib)} MB`;
}

function formatLaunchpadWorkspaceLabel(
  launchpad?: NavigationLaunchpadDraft,
  directory?: NavigationDirectorySummary
): string | undefined {
  if (!launchpad) {
    return undefined;
  }

  if (launchpad.workMode === "worktree") {
    return "New worktree";
  }

  if (directory?.kind === "workspace") {
    return "Workspace";
  }

  return directory?.gitStatus?.currentBranch
    ? `Local (${directory.gitStatus.currentBranch})`
    : "Local";
}

function buildLaunchpadWorkspaceOptions(
  launchpad: NavigationLaunchpadDraft,
  directory?: NavigationDirectorySummary
): Array<{ value: NavigationLaunchpadDraft["workMode"]; label: string }> {
  const localLabel = formatLaunchpadWorkspaceLabel(
    { ...launchpad, workMode: "local" },
    directory
  );
  const canCreateWorktree = Boolean(
    directory?.path &&
      directory.kind === "directory" &&
      (directory.gitStatus?.currentBranch ||
        (directory.gitStatus?.branches?.length ?? 0) > 0)
  );
  const options: Array<{ value: NavigationLaunchpadDraft["workMode"]; label: string }> = [
    { value: "local", label: localLabel ?? "Local" },
  ];

  if (canCreateWorktree) {
    options.push({ value: "worktree", label: "New worktree" });
  }

  return options;
}

function formatThreadWorkspaceLabel(thread?: NavigationThreadSummary): string | undefined {
  if (!thread) {
    return undefined;
  }

  if (thread.linkedDirectories.some((directory) => directory.kind === "worktree")) {
    return "Worktree";
  }

  if (
    thread.linkedDirectories.some((directory) => directory.kind === "local") ||
    thread.projectKey
  ) {
    return "Local";
  }

  return undefined;
}

type ThreadWorkspace = {
  mode: "local" | "worktree";
  /** Repository/local checkout path. In Worktree mode this is not the command CWD. */
  repositoryPath: string;
  /** Current workspace path for opening apps and running thread-scoped commands. */
  sourcePath: string;
};

/**
 * Single renderer source of truth for workspace-opening commands in the
 * thread composer. VS Code, terminal, and environment Run must all use this
 * value so Worktree threads launch from worktreePath and Local threads launch
 * from path.
 */
function getComposerWorkspaceOpenPath(params: {
  directory?: NavigationDirectorySummary;
  launchpad?: NavigationLaunchpadDraft;
  threadWorkspace?: ThreadWorkspace;
}): string | undefined {
  if (params.launchpad) {
    return undefined;
  }

  return params.threadWorkspace?.sourcePath ?? params.directory?.path;
}

function getThreadWorkspace(thread: NavigationThreadSummary): ThreadWorkspace | undefined {
  const worktreeDirectory = thread.linkedDirectories.find(
    (directory) => directory.kind === "worktree"
  );
  if (worktreeDirectory) {
    return {
      mode: "worktree",
      repositoryPath: worktreeDirectory.path,
      sourcePath: worktreeDirectory.worktreePath ?? worktreeDirectory.path,
    };
  }

  const localDirectory = thread.linkedDirectories.find(
    (directory) => directory.kind === "local"
  );
  if (localDirectory) {
    return {
      mode: "local",
      repositoryPath: localDirectory.path,
      sourcePath: localDirectory.path,
    };
  }

  if (thread.projectKey) {
    return {
      mode: "local",
      repositoryPath: thread.projectKey,
      sourcePath: thread.projectKey,
    };
  }

  return undefined;
}

function buildHandoffBranchSuggestion(sourceBranch: string | undefined): string {
  const normalizedSource = sourceBranch
    ?.replace(/^refs\/heads\//, "")
    .trim()
    .replace(/[^a-zA-Z0-9._/-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^-+|-+$/g, "");
  const branchSlug =
    normalizedSource && normalizedSource !== "HEAD" ? normalizedSource : "detached";
  return `pwragent/${branchSlug}-handoff`;
}

function getLeaveLocalBranchOptions(params: {
  currentBranch?: string;
  directory?: NavigationDirectorySummary;
}): string[] {
  const currentBranch = params.currentBranch?.trim();
  const explicitHandoffBranches = params.directory?.gitStatus?.handoffBranches;
  const branches = explicitHandoffBranches ?? params.directory?.gitStatus?.branches ?? [];
  const candidates = branches.filter(
    (branch) => branch && branch !== "HEAD" && branch !== currentBranch
  );
  const defaultBranch = params.directory?.gitStatus?.defaultBranch;
  const preferred =
    defaultBranch && candidates.includes(defaultBranch)
      ? defaultBranch
      : ["main", "master", "develop", "trunk"].find((branch) =>
          candidates.includes(branch)
        );
  const ordered = preferred
    ? [preferred, ...candidates.filter((branch) => branch !== preferred)]
    : candidates;

  return ["HEAD", ...new Set(ordered)];
}

function formatLeaveLocalBranchOption(branch: string): string {
  return branch === "HEAD" ? "Detached HEAD" : branch;
}
