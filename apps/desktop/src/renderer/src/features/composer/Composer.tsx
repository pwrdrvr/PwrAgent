import { type ClipboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppServerCollaborationModeRequest,
  AppServerReviewTarget,
  AppServerSkillSummary,
  AppServerThreadImagePart,
  AppServerTurnInputItem,
  BackendSummary,
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
    >
  ) => Promise<void>;
  removeOptimisticMessage?: (id: string) => void;
  setExecutionModeError?: string;
  skillError?: string;
  skillLoading?: boolean;
  skills: AppServerSkillSummary[];
  thread?: NavigationThreadSummary;
  updatingExecutionMode?: ThreadExecutionMode;
  onSetExecutionMode?: (executionMode: ThreadExecutionMode) => Promise<void>;
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

type PastedImageFile = {
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

type ReviewConfigState = {
  branch: string;
  commit: string;
  customInstructions: string;
  target?: ReviewTargetChoice;
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

export function Composer(props: ComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const activeTurnIdRef = useRef<string | undefined>(undefined);
  const autocompleteOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const hydratedLaunchpadKeyRef = useRef<string | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
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
    updateActiveTurnId(undefined);
    setActiveOptimisticMessageId(undefined);
    setReviewConfig(undefined);
  }, [isLaunchpad, props.launchpad?.directoryKey]);

  useEffect(() => {
    if (!props.thread) {
      return;
    }

    setDraft("");
    setSending(false);
    setInterrupting(false);
    updateActiveTurnId(undefined);
    setActiveOptimisticMessageId(undefined);
    setReviewConfig(undefined);
    setImageAttachments([]);
  }, [props.thread?.id, props.thread?.source]);

  useEffect(() => {
    updateActiveTurnId(props.activeTurnId);

    if (!props.activeTurnId) {
      setSending(false);
      setInterrupting(false);
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

  const submitTurn = async (): Promise<void> => {
    const reviewCommand = parseReviewCommand(draft);
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

    const text = hydrateSkillLabelsWithMarkdown(draft.trim(), mentionedSkills);
    const imageParts = imageAttachments.map((attachment, index) => ({
      type: "image" as const,
      url: attachment.url,
      alt: formatPastedImageAlt(attachment, index),
    }));
    const input: AppServerTurnInputItem[] = [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...imageParts.map(({ url }) => ({ type: "image" as const, url })),
    ];
    const collaborationMode = planModeEnabled && supportsPlanMode
      ? ({
          mode: "plan",
          settings: {
            developerInstructions: null,
          },
        } satisfies AppServerCollaborationModeRequest)
      : undefined;

    if (input.length === 0 || props.disabled) {
      return;
    }

    setSendError(undefined);
    setSending(true);

    if (props.launchpad && props.onMaterializeLaunchpad) {
      try {
        await props.onMaterializeLaunchpad(
          props.launchpad.directoryKey,
          input,
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

    props.onPendingStatusChange?.(collaborationMode ? "Planning" : "Thinking");
    const optimisticMessageId = props.addOptimisticUserMessage?.(text, imageParts);
    setActiveOptimisticMessageId(optimisticMessageId);

    try {
      const response = await props.desktopApi.startTurn({
        backend: props.thread.source,
        threadId: props.thread.id,
        input,
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
      setDraft("");
      setImageAttachments([]);
      if (collaborationMode) {
        setPlanModeEnabled(false);
      }
    } catch (error) {
      if (optimisticMessageId) {
        props.removeOptimisticMessage?.(optimisticMessageId);
      }
      props.onPendingStatusChange?.(undefined);
      setSending(false);
      setInterrupting(false);
      updateActiveTurnId(undefined);
      props.onActiveTurnIdChange?.(undefined);
      setActiveOptimisticMessageId(undefined);
      setSendError(error instanceof Error ? error.message : String(error));
    }
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
    const pastedFiles = getPastedImageFiles(event.clipboardData);
    if (pastedFiles.length === 0) {
      return;
    }

    event.preventDefault();
    setSendError(undefined);
    void attachPastedImages(pastedFiles);
  };

  const attachPastedImages = async (files: PastedImageFile[]): Promise<void> => {
    try {
      const nextAttachments = await Promise.all(
        files.map(async ({ file, type }, index) => {
          const normalized = await normalizeImageFile(file, {
            fallback: props.desktopApi?.normalizeImageForUpload,
          });
          void props.desktopApi?.recordImageUploadNormalization?.({
            fileName: file.name || formatPastedImageName(type, index),
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
            name: file.name || formatPastedImageName(type, index),
            size: normalized.size,
            type: normalized.mimeType,
            url: normalized.dataUrl,
            width: normalized.width,
            height: normalized.height,
          };
        })
      );

      setImageAttachments((current) => {
        const mergedAttachments = [...current, ...nextAttachments];
        persistLaunchpadImageAttachments(mergedAttachments);
        return mergedAttachments;
      });
    } catch (error) {
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
    void props.onUpdateLaunchpad(props.launchpad.directoryKey, patch);
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
  const launchpadWorkspaceOptions = props.launchpad
    ? buildLaunchpadWorkspaceOptions(props.launchpad, props.directory)
    : [];

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submitTurn();
      }}
    >
      <label className="composer__label" htmlFor="thread-composer">
        {isLaunchpad ? "New thread" : "Reply"}
      </label>

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
          disabled={sending}
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
          onClick={() => {
            setActiveSkillIndex(0);
            setActiveSlashIndex(0);
          }}
          onKeyDown={(event) => {
            if (!hasAutocomplete) {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submitTurn();
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
            <select
              id="composer-provider"
              aria-label="Provider"
              className="composer__select"
              value={props.launchpad.backend}
              onChange={(event) => {
                const currentLaunchpad = props.launchpad;
                if (!currentLaunchpad) {
                  return;
                }
                const nextBackend = event.target.value as NavigationLaunchpadDraft["backend"];
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
            >
              {providerOptions.map((candidate) => (
                <option key={candidate.kind} value={candidate.kind}>
                  {formatBackendLabel(candidate.kind)}
                </option>
              ))}
            </select>
          ) : props.thread ? (
            <span className="composer__fixed-value" aria-label="Provider">
              {formatBackendLabel(props.thread.source)}
            </span>
          ) : null}

          {availableExecutionModes.length > 0 &&
          (props.launchpad || (props.thread?.source === "codex" && props.onSetExecutionMode)) ? (
            <select
              aria-label="Access mode"
              className="composer__select composer__select--compact"
              disabled={Boolean(props.updatingExecutionMode)}
              value={
                props.launchpad?.executionMode ??
                props.thread?.executionMode ??
                "default"
              }
              onChange={(event) => {
                const executionMode = event.target.value as ThreadExecutionMode;
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
            >
              {availableExecutionModes.map((mode) => (
                <option key={mode.mode} value={mode.mode}>
                  {formatExecutionModeLabel(mode.mode)}
                </option>
              ))}
            </select>
          ) : null}

          {props.launchpad ? (
            <select
              aria-label="Workspace mode"
              className="composer__select composer__select--compact"
              disabled={!props.onUpdateLaunchpad || launchpadWorkspaceOptions.length <= 1}
              value={props.launchpad.workMode}
              onChange={(event) => {
                handleLaunchpadPatch({
                  workMode: event.target.value as NavigationLaunchpadDraft["workMode"],
                });
              }}
            >
              {launchpadWorkspaceOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : workspaceLabel ? (
            <select
              aria-label="Workspace mode"
              className="composer__select composer__select--compact"
              disabled
              value={workspaceLabel}
              onChange={() => undefined}
            >
              <option value={workspaceLabel}>{workspaceLabel}</option>
            </select>
          ) : null}

          {props.launchpad &&
          props.launchpad.workMode === "worktree" &&
          (props.directory?.gitStatus?.branches?.length ?? 0) > 0 ? (
            <select
              aria-label="Base branch"
              id="launchpad-branch"
              className="composer__select composer__select--compact"
              value={
                props.launchpad.branchName ??
                props.directory?.gitStatus?.currentBranch ??
                ""
              }
              onChange={(event) => {
                handleLaunchpadPatch({ branchName: event.target.value || undefined });
              }}
            >
              {(props.directory?.gitStatus?.branches ?? []).map((branch) => (
                <option key={branch} value={branch}>
                  {branch}
                </option>
              ))}
            </select>
          ) : null}

          {(props.launchpad || props.thread) && backend?.launchpadOptions?.models?.length ? (
            <select
              id="composer-model"
              aria-label="Model"
              className="composer__select"
              value={selectedModelOption?.id ?? ""}
              onChange={(event) => {
                const model = event.target.value;
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
            >
              {backend.launchpadOptions.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label ?? model.id}
                </option>
              ))}
            </select>
          ) : null}

          {(props.launchpad || props.thread) &&
          supportsReasoning &&
          backend?.launchpadOptions?.reasoningEfforts?.length ? (
            <select
              id="composer-reasoning"
              aria-label="Reasoning"
              className="composer__select"
              value={selectedReasoningEffort ?? ""}
              onChange={(event) => {
                const reasoningEffort = event.target.value;
                if (props.launchpad) {
                  handleLaunchpadPatch({ reasoningEffort });
                  return;
                }
                handleThreadModelSettingsPatch({ reasoningEffort });
              }}
            >
              {backend.launchpadOptions.reasoningEfforts.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
          ) : null}

          {(props.launchpad || props.thread) && backend?.launchpadOptions?.serviceTiers?.length ? (
            <select
              id="composer-service-tier"
              aria-label="Service tier"
              className="composer__select"
              value={selectedServiceTier ?? ""}
              onChange={(event) => {
                const serviceTier = event.target.value;
                if (props.launchpad) {
                  handleLaunchpadPatch({ serviceTier });
                  return;
                }
                handleThreadModelSettingsPatch({ serviceTier });
              }}
            >
              {backend.launchpadOptions.serviceTiers.map((tier) => (
                <option key={tier} value={tier}>
                  {tier}
                </option>
              ))}
            </select>
          ) : null}

          {(props.launchpad || props.thread) && supportsFast ? (
            <label className="composer__checkbox">
              <input
                checked={Boolean(currentSettings?.fastMode)}
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
      ) : props.launchpad ? (
        <p className="composer__meta">
          Changes here become the default for future new-thread launchpads. Existing threads keep their current settings.
        </p>
      ) : null}

      <div className="composer__actions">
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
          disabled={props.disabled || sending || (!draft.trim() && imageAttachments.length === 0)}
          type="submit"
        >
          {sending
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

function getPastedImageFiles(clipboardData: DataTransfer): PastedImageFile[] {
  const files: PastedImageFile[] = [];
  const seenFiles = new Set<string>();
  let foundImageItem = false;

  for (const item of Array.from(clipboardData.items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) {
      continue;
    }

    const file = item.getAsFile();
    if (!file) {
      continue;
    }

    foundImageItem = true;
    const key = buildFileKey(file);
    if (!seenFiles.has(key)) {
      files.push({ file, type: item.type });
      seenFiles.add(key);
    }
  }

  if (foundImageItem) {
    return files;
  }

  for (const file of Array.from(clipboardData.files)) {
    if (!file.type.startsWith("image/")) {
      continue;
    }

    const key = buildFileKey(file);
    if (!seenFiles.has(key)) {
      files.push({ file, type: file.type });
      seenFiles.add(key);
    }
  }

  return files;
}

function buildFileKey(file: File): string {
  return `${file.name}:${file.type}:${file.size}:${file.lastModified}`;
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
    return thread.gitBranch ? `Local (${thread.gitBranch})` : "Local";
  }

  return undefined;
}
