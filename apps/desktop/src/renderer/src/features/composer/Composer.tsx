import {
  type ReactNode,
  type ClipboardEvent,
  type DragEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AppServerCollaborationModeRequest,
  AppServerReviewTarget,
  AppServerSkillSummary,
  AppServerThreadImagePart,
  AppServerTurnInputItem,
  BackendSummary,
  DesktopChatReplyComposer,
  HandoffThreadWorkspaceRequest,
  NavigationDirectorySummary,
  NavigationLaunchpadDraft,
  NavigationLaunchpadImageAttachment,
  NavigationThreadSummary,
  ThreadExecutionMode,
} from "@pwragnt/shared";
import { formatBackendLabel } from "../../lib/backend-label";
import type { DesktopApi } from "../../lib/desktop-api";
import { formatExecutionModeLabel } from "../../lib/execution-mode";
import { normalizeImageFile } from "../../lib/image-normalization";
import type { ThreadContextWindowState } from "../../lib/useThreadSessionState";
import {
  findSkillTrigger,
  hydrateSkillLabelsWithMarkdown,
  insertSkillLabel,
  listMentionedSkills,
} from "../../lib/skill-mentions";
import { parseReviewCommand } from "../../../../shared/review-command";
import { SkillChip } from "./SkillChip";

type ComposerProps = {
  activeTurnId?: string;
  addOptimisticReviewEntry?: (displayText: string) => string;
  addOptimisticUserMessage?: (
    text: string,
    imageParts?: AppServerThreadImagePart[]
  ) => string;
  backends?: BackendSummary[];
  desktopApi?: DesktopApi;
  directory?: NavigationDirectorySummary;
  disabled?: boolean;
  contextWindow?: ThreadContextWindowState;
  composerImplementation?: DesktopChatReplyComposer;
  launchpad?: NavigationLaunchpadDraft;
  launchpadError?: string;
  onActiveTurnIdChange?: (turnId?: string) => void;
  onEnsureSkillsLoaded?: () => void | Promise<void>;
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
  onUpdateLaunchpad?: (
    directoryKey: string,
    patch: Partial<
      Pick<
        NavigationLaunchpadDraft,
        | "prompt"
        | "backend"
        | "executionMode"
        | "model"
        | "reasoningEffort"
        | "serviceTier"
        | "fastMode"
        | "workMode"
        | "branchName"
        | "directoryLabel"
        | "directoryPath"
        | "imageAttachments"
      >
    >,
    options?: { stickySettingsChanged?: boolean }
  ) => Promise<void>;
  removeOptimisticMessage?: (id: string) => void;
  setExecutionModeError?: string;
  skillError?: string;
  skillLoading?: boolean;
  skills: AppServerSkillSummary[];
  thread?: NavigationThreadSummary;
  updatingExecutionMode?: ThreadExecutionMode;
  onSetExecutionMode?: (executionMode: ThreadExecutionMode) => Promise<void>;
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

type ComposerImageAttachment = NavigationLaunchpadImageAttachment;

type ComposerDropdownOption = {
  disabled?: boolean;
  label: string;
  value: string;
};

type QueuedTurnDraft = {
  imageAttachments: ComposerImageAttachment[];
  text: string;
};

type PendingSteerDraft = QueuedTurnDraft & {
  status: "pending" | "steering";
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

type ComposerDraftState = {
  draft: string;
  imageAttachments: ComposerImageAttachment[];
};

const DEFAULT_REASONING_EFFORT = "medium";

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

export function Composer(props: ComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const activeTurnIdRef = useRef<string | undefined>(undefined);
  const autocompleteOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const hydratedLaunchpadKeyRef = useRef<string | undefined>(undefined);
  const composerScopeKey = props.launchpad
    ? `launchpad:${props.launchpad.directoryKey}`
    : props.thread
      ? `thread:${props.thread.source}:${props.thread.id}`
      : "empty";
  const activeComposerScopeKeyRef = useRef(composerScopeKey);
  const scopedThreadDraftsRef = useRef(new Map<string, ComposerDraftState>());
  const pasteScopeRef = useRef({ key: composerScopeKey, version: 0 });
  const [draft, setDraft] = useState("");
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const workspaceMenuRef = useDismissableMenu<HTMLDivElement>(
    workspaceMenuOpen,
    () => setWorkspaceMenuOpen(false),
  );
  const [handoffDialog, setHandoffDialog] = useState<
    HandoffThreadWorkspaceRequest["direction"] | undefined
  >();
  const [leaveLocalBranch, setLeaveLocalBranch] = useState("");
  const [handoffError, setHandoffError] = useState<string | undefined>();
  const [handoffSubmitting, setHandoffSubmitting] = useState(false);
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [steering, setSteering] = useState(false);
  const [queuedTurn, setQueuedTurn] = useState<QueuedTurnDraft>();
  const [pendingSteer, setPendingSteer] = useState<PendingSteerDraft>();
  const [activeTurnId, setActiveTurnId] = useState<string | undefined>(undefined);
  const [sendError, setSendError] = useState<string>();
  const [imageAttachments, setImageAttachments] = useState<ComposerImageAttachment[]>([]);
  const [planModeEnabled, setPlanModeEnabled] = useState(false);
  const [activeSkillIndex, setActiveSkillIndex] = useState(0);
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
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

  const selectionStart = inputRef.current?.selectionStart ?? draft.length;
  const isThreadComposerScope = (scopeKey: string): boolean =>
    scopeKey.startsWith("thread:");
  const saveThreadComposerDraft = (
    scopeKey: string,
    state: ComposerDraftState,
  ): void => {
    if (!isThreadComposerScope(scopeKey)) {
      return;
    }

    if (!state.draft.trim() && state.imageAttachments.length === 0) {
      scopedThreadDraftsRef.current.delete(scopeKey);
      return;
    }

    scopedThreadDraftsRef.current.set(scopeKey, state);
  };
  const clearThreadComposerDraft = (scopeKey: string): void => {
    if (isThreadComposerScope(scopeKey)) {
      scopedThreadDraftsRef.current.delete(scopeKey);
    }
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
    return props.skills.filter((skill) => {
      if (!skill.path) {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      return (
        skill.name.toLowerCase().includes(normalizedQuery) ||
        skill.description?.toLowerCase().includes(normalizedQuery) ||
        skill.shortDescription?.toLowerCase().includes(normalizedQuery)
      );
    });
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
  const displayedAutocompleteKind: AutocompleteKind | undefined = trigger && filteredSkills.length > 0
    ? "skills"
    : slashTrigger && filteredSlashCommands.length > 0
      ? "slash"
      : undefined;
  const autocompleteKind: AutocompleteKind | undefined =
    displayedAutocompleteKind === "slash" &&
    parseReviewCommand(draft) &&
    draft.trim() === "/review"
      ? undefined
      : displayedAutocompleteKind;
  const hasAutocomplete = Boolean(autocompleteKind);
  const activeAutocompleteIndex =
    displayedAutocompleteKind === "skills" ? activeSkillIndex : activeSlashIndex;
  const autocompleteLength =
    displayedAutocompleteKind === "skills" ? filteredSkills.length : filteredSlashCommands.length;
  const mentionedSkills = useMemo(
    () => listMentionedSkills(draft, props.skills),
    [draft, props.skills]
  );
  const reviewBranchOptions = useMemo(
    () => buildReviewBranchOptions({
      directory: props.directory,
      thread: props.thread,
    }),
    [props.directory, props.thread]
  );
  const isBareReviewCommand = draft.trim() === "/review";

  useEffect(() => {
    const previousScopeKey = activeComposerScopeKeyRef.current;
    if (previousScopeKey === composerScopeKey) {
      return;
    }

    saveThreadComposerDraft(previousScopeKey, {
      draft,
      imageAttachments,
    });

    activeComposerScopeKeyRef.current = composerScopeKey;
    const current = pasteScopeRef.current;
    pasteScopeRef.current = {
      key: composerScopeKey,
      version: current.version + 1,
    };

    if (props.thread) {
      const saved = scopedThreadDraftsRef.current.get(composerScopeKey);
      setDraft(saved?.draft ?? "");
      setImageAttachments(saved?.imageAttachments ?? []);
    }
    setSending(false);
    setInterrupting(false);
    setSteering(false);
    updateActiveTurnId(undefined);
    setActiveOptimisticMessageId(undefined);
    setReviewConfig(undefined);
    setQueuedTurn(undefined);
    setPendingSteer(undefined);
  }, [composerScopeKey]);

  useEffect(() => {
    setActiveSkillIndex(0);
  }, [trigger?.query, props.launchpad?.directoryKey, props.thread?.id]);

  useEffect(() => {
    setActiveSlashIndex(0);
  }, [slashTrigger?.query, props.launchpad?.directoryKey, props.thread?.id]);

  useEffect(() => {
    if (!displayedAutocompleteKind) {
      return;
    }

    autocompleteOptionRefs.current[activeAutocompleteIndex]?.scrollIntoView?.({
      block: "nearest",
    });
  }, [activeAutocompleteIndex, displayedAutocompleteKind]);

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
    setDraft(props.launchpad?.prompt ?? "");
    setImageAttachments(props.launchpad?.imageAttachments ?? []);
    setSending(false);
    setInterrupting(false);
    setSteering(false);
    updateActiveTurnId(undefined);
    setActiveOptimisticMessageId(undefined);
    setReviewConfig(undefined);
    setQueuedTurn(undefined);
    setPendingSteer(undefined);
  }, [isLaunchpad, props.launchpad?.directoryKey]);

  useEffect(() => {
    if (!props.thread) {
      return;
    }

    activeComposerScopeKeyRef.current = composerScopeKey;
  }, [composerScopeKey, props.thread]);

  useEffect(() => {
    updateActiveTurnId(props.activeTurnId);

    if (!props.activeTurnId) {
      setSending(false);
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
        setSending(false);
        setInterrupting(false);
        setSteering(false);
        if (pendingSteer?.status === "pending") {
          if (queuedTurn) {
            setDraft(pendingSteer.text);
            setImageAttachments(pendingSteer.imageAttachments);
          } else {
            setQueuedTurn({
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
        setSending(false);
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

    if (draft === launchpad.prompt) {
      return;
    }

    const timeout = window.setTimeout(() => {
      void props.onUpdateLaunchpad?.(launchpad.directoryKey, {
        imageAttachments: imageAttachments.length > 0 ? imageAttachments : undefined,
        prompt: draft,
      });
    }, 250);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [draft, imageAttachments, launchpad, props.onUpdateLaunchpad]);

  const submitReviewCommand = async (reviewCommand: {
    displayText: string;
    target: AppServerReviewTarget;
  }): Promise<void> => {
    if (props.disabled) {
      return;
    }
    if (imageAttachments.length > 0) {
      setSendError("/review does not accept image attachments.");
      return;
    }

    setSendError(undefined);
    setSending(true);
    props.onPendingStatusChange?.("Reviewing");

    if (props.launchpad && props.onMaterializeLaunchpad) {
      try {
        await props.onMaterializeLaunchpad(
          props.launchpad.directoryKey,
          undefined,
          undefined,
          reviewCommand.target
        );
        setDraft("");
        setReviewConfig(undefined);
        setImageAttachments([]);
      } catch (error) {
        props.onPendingStatusChange?.(undefined);
        setSendError(error instanceof Error ? error.message : String(error));
      } finally {
        setSending(false);
      }
      return;
    }

    if (!props.thread || !props.desktopApi?.startReview) {
      props.onPendingStatusChange?.(undefined);
      setSending(false);
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
      clearThreadComposerDraft(composerScopeKey);
      setDraft("");
      setReviewConfig(undefined);
    } catch (error) {
      if (optimisticReviewId) {
        props.removeOptimisticMessage?.(optimisticReviewId);
      }
      props.onPendingStatusChange?.(undefined);
      setSending(false);
      setInterrupting(false);
      updateActiveTurnId(undefined);
      props.onActiveTurnIdChange?.(undefined);
      setSendError(error instanceof Error ? error.message : String(error));
    }
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

  const sendThreadTurn = async (queued?: QueuedTurnDraft): Promise<void> => {
    if (!props.thread || !props.desktopApi?.startTurn) {
      return;
    }

    const payload = queued
      ? buildTurnPayload(queued.text, queued.imageAttachments)
      : buildTurnPayload(draft, imageAttachments);
    if (payload.input.length === 0 || props.disabled) {
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
      setSending(false);
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
        setQueuedTurn(undefined);
      } else {
        clearThreadComposerDraft(composerScopeKey);
        setDraft("");
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
      setSending(false);
      setInterrupting(false);
      setSteering(false);
      updateActiveTurnId(undefined);
      props.onActiveTurnIdChange?.(undefined);
      setActiveOptimisticMessageId(undefined);
      setSendError(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    if (!queuedTurn || activeTurnId || sending || props.launchpad || props.disabled) {
      return;
    }

    setSending(true);
    void sendThreadTurn(queuedTurn).finally(() => {
      setSending(false);
    });
  }, [activeTurnId, queuedTurn, sending, props.disabled, props.launchpad]);

  const queueCurrentDraft = (): void => {
    if (!draft.trim() && imageAttachments.length === 0) {
      return;
    }
    if (queuedTurn) {
      setSendError("A message is already queued.");
      return;
    }

    setQueuedTurn({
      text: draft,
      imageAttachments,
    });
    clearThreadComposerDraft(composerScopeKey);
    setDraft("");
    setImageAttachments([]);
    setReviewConfig(undefined);
    setSendError(undefined);
  };

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
    setPendingSteer((current) =>
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
      setPendingSteer((current) =>
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
      text: pending.text,
      imageAttachments: pending.imageAttachments,
      status: "pending",
    });
    clearThreadComposerDraft(composerScopeKey);
    setDraft("");
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
      text: draft,
      imageAttachments,
    });
  };

  const steerQueuedTurn = (queued: QueuedTurnDraft): void => {
    if (!createPendingSteer(queued)) {
      return;
    }
    setQueuedTurn(undefined);
    if (activeTurnIdRef.current) {
      void submitPendingSteer(queued);
    }
  };

  const submitTurn = async (mode: "default" | "steer" = "default"): Promise<void> => {
    const reviewCommand = parseReviewCommand(draft);
    if (activeTurnIdRef.current && !props.launchpad) {
      if (mode === "steer") {
        steerCurrentDraft();
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

    const payload = buildTurnPayload(draft, imageAttachments);
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
    setSending(true);

    if (props.launchpad && props.onMaterializeLaunchpad) {
      try {
        await props.onMaterializeLaunchpad(
          props.launchpad.directoryKey,
          payload.input,
          collaborationMode
        );
        setDraft("");
        setImageAttachments([]);
        if (collaborationMode) {
          setPlanModeEnabled(false);
        }
      } catch (error) {
        setSendError(error instanceof Error ? error.message : String(error));
      } finally {
        setSending(false);
      }
      return;
    }

    if (!props.thread || !props.desktopApi?.startTurn) {
      setSending(false);
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

    const inserted = insertSkillLabel({
      draft,
      skill,
      selectionStart: inputRef.current.selectionStart ?? draft.length,
      selectionEnd: inputRef.current.selectionEnd ?? draft.length,
    });
    if (!inserted) {
      return;
    }

    setDraft(inserted.nextDraft);
    setActiveSkillIndex(0);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(inserted.nextSelection, inserted.nextSelection);
    });
  };

  const applySlashCommand = (command: SlashCommandSuggestion): void => {
    if (!inputRef.current) {
      return;
    }

    const selectionStart = inputRef.current.selectionStart ?? draft.length;
    const selectionEnd = inputRef.current.selectionEnd ?? selectionStart;
    const trigger = findSlashCommandTrigger(draft, selectionStart);
    if (!trigger) {
      return;
    }

    const before = draft.slice(0, trigger.start);
    const after = draft.slice(Math.max(trigger.end, selectionEnd));
    const needsTrailingSpace = after.length === 0 || !/^\s/.test(after);
    const nextDraft = `${before}${command.insertText}${needsTrailingSpace ? " " : ""}${after}`;
    const nextSelection = before.length + command.insertText.length + (needsTrailingSpace ? 1 : 0);

    setDraft(nextDraft);
    setActiveSlashIndex(0);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextSelection, nextSelection);
    });
  };

  const removeImageAttachment = (id: string): void => {
    setImageAttachments((current) => {
      const nextAttachments = current.filter((attachment) => attachment.id !== id);
      saveThreadComposerDraft(composerScopeKey, {
        draft,
        imageAttachments: nextAttachments,
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
      prompt: draft,
    });
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const pastedFiles = getImageFilesFromDataTransfer(event.clipboardData);
    if (pastedFiles.length === 0) {
      return;
    }

    event.preventDefault();
    setSendError(undefined);
    void attachImages(pastedFiles);
  };

  const handleDragOver = (event: DragEvent<HTMLTextAreaElement>): void => {
    if (!hasImageFiles(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleDrop = (event: DragEvent<HTMLTextAreaElement>): void => {
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
    const pasteImageAttachments = imageAttachments;
    const pasteLaunchpad = props.launchpad;
    const updateLaunchpad = props.onUpdateLaunchpad;

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
        if (pasteLaunchpad && updateLaunchpad) {
          const mergedAttachments = [...pasteImageAttachments, ...nextAttachments];
          void updateLaunchpad(pasteLaunchpad.directoryKey, {
            imageAttachments: mergedAttachments.length > 0 ? mergedAttachments : undefined,
            prompt: pasteDraft,
          });
          return;
        }

        const saved = scopedThreadDraftsRef.current.get(pasteScope.key) ?? {
          draft: "",
          imageAttachments: [],
        };
        saveThreadComposerDraft(pasteScope.key, {
          draft: saved.draft,
          imageAttachments: [...saved.imageAttachments, ...nextAttachments],
        });
        return;
      }

      setImageAttachments((current) => {
        const mergedAttachments = [...current, ...nextAttachments];
        saveThreadComposerDraft(pasteScope.key, {
          draft,
          imageAttachments: mergedAttachments,
        });
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
      >
    >
  ): void => {
    if (!props.launchpad || !props.onUpdateLaunchpad) {
      return;
    }

    setSendError(undefined);
    void props.onUpdateLaunchpad(props.launchpad.directoryKey, patch, {
      stickySettingsChanged: true,
    });
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
  const threadWorkspace = props.thread ? getThreadWorkspace(props.thread) : undefined;
  const sourceBranch =
    props.directory?.gitStatus?.currentBranch ??
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

  const openHandoffDialog = (
    direction: HandoffThreadWorkspaceRequest["direction"]
  ): void => {
    setWorkspaceMenuOpen(false);
    setHandoffError(undefined);
    setHandoffDialog(direction);
    if (direction === "local-to-worktree") {
      const defaultBranch = props.directory?.gitStatus?.defaultBranch;
      setLeaveLocalBranch(
        defaultBranch && branchOptions.includes(defaultBranch)
          ? defaultBranch
          : branchOptions[0] ?? ""
      );
    }
  };

  const submitHandoff = async (): Promise<void> => {
    if (!threadWorkspace || !props.onHandoffThreadWorkspace) {
      return;
    }

    setHandoffSubmitting(true);
    setHandoffError(undefined);
    try {
      await props.onHandoffThreadWorkspace({
        direction: handoffDialog!,
        repositoryPath: threadWorkspace.repositoryPath,
        sourcePath: threadWorkspace.sourcePath,
        sourceBranch,
        leaveLocalBranch:
          handoffDialog === "local-to-worktree" ? leaveLocalBranch || undefined : undefined,
      });
      setHandoffDialog(undefined);
    } catch (error) {
      setHandoffError(error instanceof Error ? error.message : String(error));
    } finally {
      setHandoffSubmitting(false);
    }
  };

  const handoffDisabled =
    handoffSubmitting ||
    !sourceBranch ||
    (handoffDialog === "local-to-worktree" && !leaveLocalBranch);

  return (
    <form
      className="composer"
      data-composer-implementation={props.composerImplementation ?? "textarea"}
      onSubmit={(event) => {
        event.preventDefault();
        void submitTurn();
      }}
    >
      <label className="composer__label" htmlFor="thread-composer">
        {isLaunchpad ? "New thread" : "Reply"}
      </label>

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
                    setDraft(pendingSteer.text);
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

      {queuedTurn ? (
        <div className="composer__queued" aria-label="Queued message">
          <div className="composer__queued-copy">
            <span className="composer__queued-label">Queued next</span>
            <span className="composer__queued-text">
              {formatDraftPreview(queuedTurn)}
            </span>
          </div>
          <QueuedImageAttachments attachments={queuedTurn.imageAttachments} />
          <div className="composer__queued-actions">
            {supportsSteering ? (
              <button
                className="composer__secondary-action"
                disabled={props.disabled || steering || !activeTurnId}
                type="button"
                onClick={() => {
                  steerQueuedTurn(queuedTurn);
                }}
              >
                {steering ? "Steering..." : "Steer"}
              </button>
            ) : null}
            <button
              className="composer__secondary-action"
              type="button"
              onClick={() => {
                setDraft(queuedTurn.text);
                setImageAttachments(queuedTurn.imageAttachments);
                setQueuedTurn(undefined);
                requestAnimationFrame(() => inputRef.current?.focus());
              }}
            >
              Edit
            </button>
            <button
              className="composer__secondary-action"
              type="button"
              onClick={() => {
                setQueuedTurn(undefined);
              }}
            >
              Delete
            </button>
          </div>
        </div>
      ) : null}

      {mentionedSkills.length > 0 ? (
        <div className="composer__mentioned-skills" aria-label="Mentioned skills">
          {mentionedSkills.map((skill) => (
            <SkillChip key={skill.path ?? skill.name} skill={skill} />
          ))}
        </div>
      ) : null}

      <div className="composer__input-wrap">
        <textarea
          ref={inputRef}
          id="thread-composer"
          className="composer__input"
          disabled={launchpadSubmitting || (props.disabled && !draft)}
          placeholder={
            isLaunchpad
              ? `Start a new thread in ${props.launchpad?.directoryLabel ?? "this directory"}`
              : "Reply to this thread"
          }
          value={draft}
          onChange={(event) => {
            const nextDraft = event.target.value;
            setDraft(nextDraft);
            if (nextDraft.trim() !== "/review") {
              setReviewConfig(undefined);
            }
            setSendError(undefined);
          }}
          onPaste={handlePaste}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onClick={() => {
            setActiveSkillIndex(0);
            setActiveSlashIndex(0);
          }}
          onKeyDown={(event) => {
            if (!hasAutocomplete) {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submitTurn(event.metaKey ? "steer" : "default");
              }
              return;
            }

            if (event.key === "ArrowDown") {
              event.preventDefault();
              if (autocompleteKind === "skills") {
                setActiveSkillIndex((current) =>
                  Math.min(current + 1, autocompleteLength - 1)
                );
              } else {
                setActiveSlashIndex((current) =>
                  Math.min(current + 1, autocompleteLength - 1)
                );
              }
              return;
            }

            if (event.key === "ArrowUp") {
              event.preventDefault();
              if (autocompleteKind === "skills") {
                setActiveSkillIndex((current) => Math.max(current - 1, 0));
              } else {
                setActiveSlashIndex((current) => Math.max(current - 1, 0));
              }
              return;
            }

            if (event.key === "Escape") {
              event.preventDefault();
              setActiveSkillIndex(0);
              setActiveSlashIndex(0);
              return;
            }

            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (autocompleteKind === "skills") {
                applySkill(filteredSkills[activeSkillIndex] ?? filteredSkills[0]!);
              } else {
                applySlashCommand(
                  filteredSlashCommands[activeSlashIndex] ?? filteredSlashCommands[0]!
                );
              }
            }
          }}
        />

        {displayedAutocompleteKind === "skills" ? (
          <div className="composer__autocomplete" role="listbox" aria-label="Skills">
            {filteredSkills.map((skill, index) => (
              <button
                key={skill.path ?? skill.name}
                ref={(node) => {
                  autocompleteOptionRefs.current[index] = node;
                }}
                aria-selected={index === activeSkillIndex}
                className={`composer__autocomplete-option${index === activeSkillIndex ? " is-active" : ""}`}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  applySkill(skill);
                }}
                onClick={() => {
                  applySkill(skill);
                }}
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
        ) : displayedAutocompleteKind === "slash" ? (
          <div className="composer__autocomplete" role="listbox" aria-label="Commands">
            {filteredSlashCommands.map((command, index) => (
              <button
                key={command.id}
                ref={(node) => {
                  autocompleteOptionRefs.current[index] = node;
                }}
                aria-selected={index === activeSlashIndex}
                className={`composer__autocomplete-option${index === activeSlashIndex ? " is-active" : ""}`}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  applySlashCommand(command);
                }}
                onClick={() => {
                  applySlashCommand(command);
                }}
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

      {reviewConfig && isBareReviewCommand ? (
        <fieldset className="composer__review-config" aria-label="Review target">
          <legend>Review target</legend>
          <div className="composer__review-options">
            {REVIEW_TARGET_OPTIONS.map((option) => (
              <button
                key={option.target}
                type="button"
                aria-pressed={reviewConfig.target === option.target}
                className={`composer__review-option${reviewConfig.target === option.target ? " is-active" : ""}`}
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

          {reviewConfig.target === "baseBranch" ? (
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

          {reviewConfig.target === "commit" ? (
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

          {reviewConfig.target === "custom" ? (
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
              onClick={() => {
                setReviewConfig(undefined);
                setSendError(undefined);
              }}
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
      ) : null}

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
                  void props.onSetExecutionMode?.(executionMode);
                }
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
              value={props.launchpad.workMode}
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
                disabled={!props.onHandoffThreadWorkspace}
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
          props.launchpad.workMode === "worktree" &&
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

      {handoffDialog && threadWorkspace ? (
        <div className="workspace-handoff-modal">
          <div
            aria-label={
              handoffDialog === "local-to-worktree"
                ? "Handoff to New Worktree"
                : "Handoff to Local"
            }
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
                ? "Move this thread's current branch into a new worktree. Dirty tracked and non-ignored files will be stashed and applied in the new worktree."
                : "Move this worktree branch back to Local. Dirty tracked and non-ignored files will be stashed and applied in Local, then the old worktree will be archived."}
            </p>
            <dl className="workspace-handoff-dialog__summary">
              <div>
                <dt>Branch to move</dt>
                <dd>{sourceBranch ?? "Unknown branch"}</dd>
              </div>
            </dl>
            {handoffDialog === "local-to-worktree" ? (
              <label className="workspace-handoff-dialog__field">
                Leave Local on
                <select
                  aria-label="Leave Local on"
                  className="composer__select"
                  disabled={handoffSubmitting || branchOptions.length === 0}
                  value={leaveLocalBranch}
                  onChange={(event) => setLeaveLocalBranch(event.target.value)}
                >
                  {branchOptions.map((branch) => (
                    <option key={branch} value={branch}>
                      {branch}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {handoffDialog === "local-to-worktree" && branchOptions.length === 0 ? (
              <p className="workspace-handoff-dialog__note">
                No available local branch can be checked out before moving this branch.
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
                {handoffSubmitting ? "Handing off…" : "Handoff"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {props.skillError ? <p className="composer__meta composer__meta--error">{props.skillError}</p> : null}
      {props.launchpadError ? (
        <p className="composer__meta composer__meta--error">{props.launchpadError}</p>
      ) : null}
      {sendError ? <p className="composer__meta composer__meta--error">{sendError}</p> : null}
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
            (!draft.trim() && imageAttachments.length === 0)
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
    </form>
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
    formatOptionalTokenDetail("cached", contextWindow.cachedInputTokens),
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
  }

  return lines.join("\n");
}

function formatOptionalTokenDetail(label: string, value: number | undefined): string | undefined {
  return typeof value === "number" ? `${formatCompactNumber(value)} ${label}` : undefined;
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
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
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

  if (canCreateWorktree || launchpad.workMode === "worktree") {
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
  repositoryPath: string;
  sourcePath: string;
};

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

function getLeaveLocalBranchOptions(params: {
  currentBranch?: string;
  directory?: NavigationDirectorySummary;
}): string[] {
  const currentBranch = params.currentBranch?.trim();
  const explicitHandoffBranches = params.directory?.gitStatus?.handoffBranches;
  const branches = explicitHandoffBranches ?? params.directory?.gitStatus?.branches ?? [];
  const candidates = branches.filter((branch) => branch && branch !== currentBranch);
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

  return [...new Set(ordered)];
}
