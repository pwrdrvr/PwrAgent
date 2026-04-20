import { type ClipboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppServerSkillSummary,
  AppServerThreadImagePart,
  AppServerTurnInputItem,
  BackendSummary,
  NavigationDirectorySummary,
  NavigationLaunchpadDraft,
  NavigationThreadSummary,
  ThreadExecutionMode,
} from "@pwragnt/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { formatExecutionModeLabel } from "../../lib/execution-mode";
import {
  findSkillTrigger,
  hydrateSkillLabelsWithMarkdown,
  insertSkillLabel,
  listMentionedSkills,
} from "../../lib/skill-mentions";
import { SkillChip } from "./SkillChip";

type ComposerProps = {
  activeRunId?: string;
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
  onActiveRunIdChange?: (runId?: string) => void;
  onEnsureSkillsLoaded?: () => void | Promise<void>;
  pendingRequestActive?: boolean;
  onMaterializeLaunchpad?: (
    directoryKey: string,
    input?: AppServerTurnInputItem[]
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
};

type ComposerImageAttachment = {
  id: string;
  name: string;
  size: number;
  type: string;
  url: string;
};

type PastedImageFile = {
  file: File;
  type: string;
};

export function Composer(props: ComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const activeRunIdRef = useRef<string | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | undefined>(undefined);
  const [sendError, setSendError] = useState<string>();
  const [imageAttachments, setImageAttachments] = useState<ComposerImageAttachment[]>([]);
  const [activeSkillIndex, setActiveSkillIndex] = useState(0);
  const [activeOptimisticMessageId, setActiveOptimisticMessageId] = useState<string>();
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
  const updateActiveRunId = (nextRunId?: string): void => {
    activeRunIdRef.current = nextRunId;
    setActiveRunId(nextRunId);
  };
  const trigger = findSkillTrigger(draft, selectionStart);
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
  const hasAutocomplete = Boolean(trigger && filteredSkills.length > 0);
  const mentionedSkills = useMemo(
    () => listMentionedSkills(draft, props.skills),
    [draft, props.skills]
  );

  useEffect(() => {
    setActiveSkillIndex(0);
  }, [trigger?.query, props.launchpad?.directoryKey, props.thread?.id]);

  useEffect(() => {
    if (!trigger) {
      return;
    }

    void props.onEnsureSkillsLoaded?.();
  }, [props.onEnsureSkillsLoaded, trigger]);

  useEffect(() => {
    if (!isLaunchpad) {
      return;
    }

    setDraft(props.launchpad?.prompt ?? "");
    setSending(false);
    setInterrupting(false);
    updateActiveRunId(undefined);
    setActiveOptimisticMessageId(undefined);
  }, [isLaunchpad, props.launchpad?.directoryKey, props.launchpad?.updatedAt]);

  useEffect(() => {
    setImageAttachments([]);
  }, [props.launchpad?.directoryKey]);

  useEffect(() => {
    if (!props.thread) {
      return;
    }

    setDraft("");
    setSending(false);
    setInterrupting(false);
    updateActiveRunId(undefined);
    setActiveOptimisticMessageId(undefined);
    setImageAttachments([]);
  }, [props.thread?.id, props.thread?.source]);

  useEffect(() => {
    updateActiveRunId(props.activeRunId);

    if (!props.activeRunId) {
      setSending(false);
      setInterrupting(false);
    }
  }, [props.activeRunId]);

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
        updateActiveRunId(startedTurnRecord.id);
        props.onActiveRunIdChange?.(startedTurnRecord.id);
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
        updateActiveRunId(undefined);
        props.onActiveRunIdChange?.(undefined);
        setActiveOptimisticMessageId(undefined);
        return;
      }

      if (
        event.notification.method === "thread/status/changed" &&
        statusRecord?.type === "idle"
      ) {
        if (activeRunIdRef.current) {
          return;
        }

        props.onPendingStatusChange?.(undefined);
        setSending(false);
        setInterrupting(false);
        updateActiveRunId(undefined);
        props.onActiveRunIdChange?.(undefined);
        setActiveOptimisticMessageId(undefined);
      }
    });
  }, [
    activeOptimisticMessageId,
    props.desktopApi,
    props.onActiveRunIdChange,
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
        prompt: draft,
      });
    }, 250);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [draft, launchpad, props.onUpdateLaunchpad]);

  const submitTurn = async (): Promise<void> => {
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

    if (input.length === 0 || props.disabled) {
      return;
    }

    setSendError(undefined);
    setSending(true);

    if (props.launchpad && props.onMaterializeLaunchpad) {
      try {
        await props.onMaterializeLaunchpad(props.launchpad.directoryKey, input);
        setDraft("");
        setImageAttachments([]);
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

    props.onPendingStatusChange?.("Thinking");
    const optimisticMessageId = props.addOptimisticUserMessage?.(text, imageParts);
    setActiveOptimisticMessageId(optimisticMessageId);

    try {
      const response = await props.desktopApi.startTurn({
        backend: props.thread.source,
        threadId: props.thread.id,
        input,
      });
      updateActiveRunId(response.runId);
      props.onActiveRunIdChange?.(response.runId);
      setDraft("");
      setImageAttachments([]);
    } catch (error) {
      if (optimisticMessageId) {
        props.removeOptimisticMessage?.(optimisticMessageId);
      }
      props.onPendingStatusChange?.(undefined);
      setSending(false);
      setInterrupting(false);
      updateActiveRunId(undefined);
      props.onActiveRunIdChange?.(undefined);
      setActiveOptimisticMessageId(undefined);
      setSendError(error instanceof Error ? error.message : String(error));
    }
  };

  const stopTurn = async (): Promise<void> => {
    const runId = activeRunIdRef.current;
    if (
      !props.thread ||
      !runId ||
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
        runId,
      });
    } catch (error) {
      setInterrupting(false);
      props.onPendingStatusChange?.(
        props.pendingRequestActive ? "Waiting for approval" : "Thinking"
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

  const removeImageAttachment = (id: string): void => {
    setImageAttachments((current) =>
      current.filter((attachment) => attachment.id !== id)
    );
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
        files.map(async ({ file, type }, index) => ({
          id: `pasted-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name || formatPastedImageName(type, index),
          size: file.size,
          type,
          url: await readFileAsDataUrl(file, type),
        }))
      );

      setImageAttachments((current) => [...current, ...nextAttachments]);
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

  const currentModelOption = backend?.launchpadOptions?.models?.find(
    (option) => option.id === props.launchpad?.model
  );
  const supportsReasoning =
    currentModelOption?.supportsReasoning ??
    Boolean(backend?.launchpadOptions?.reasoningEfforts?.length);
  const supportsFast =
    currentModelOption?.supportsFast ??
    backend?.launchpadOptions?.supportsFastMode ??
    false;
  const availableExecutionModes =
    backend?.executionModes.filter((mode) => mode.available) ?? [];
  const workspaceLabel = formatThreadWorkspaceLabel(props.thread);
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
            setDraft(event.target.value);
            setSendError(undefined);
          }}
          onPaste={handlePaste}
          onClick={() => {
            setActiveSkillIndex(0);
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
              setActiveSkillIndex((current) =>
                Math.min(current + 1, filteredSkills.length - 1)
              );
              return;
            }

            if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveSkillIndex((current) => Math.max(current - 1, 0));
              return;
            }

            if (event.key === "Escape") {
              event.preventDefault();
              setActiveSkillIndex(0);
              return;
            }

            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              applySkill(filteredSkills[activeSkillIndex] ?? filteredSkills[0]!);
            }
          }}
        />

        {hasAutocomplete ? (
          <div className="composer__autocomplete" role="listbox" aria-label="Skills">
            {filteredSkills.map((skill, index) => (
              <button
                key={skill.path ?? skill.name}
                aria-selected={index === activeSkillIndex}
                className={`composer__skill-option${index === activeSkillIndex ? " is-active" : ""}`}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  applySkill(skill);
                }}
                onClick={() => {
                  applySkill(skill);
                }}
              >
                <span className="composer__skill-option-title">
                  <span aria-hidden="true">🧰</span>
                  <span>{`$${skill.name}`}</span>
                </span>
                <span className="composer__skill-option-meta">
                  {skill.shortDescription || skill.description || skill.path}
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

          {props.launchpad && backend?.launchpadOptions?.models?.length ? (
            <div className="composer__control-group">
              <label className="composer__control-label" htmlFor="launchpad-model">
                Model
              </label>
              <select
                id="launchpad-model"
                className="composer__select"
                value={props.launchpad.model ?? ""}
                onChange={(event) => {
                  handleLaunchpadPatch({ model: event.target.value || undefined });
                }}
              >
                <option value="">Default</option>
                {backend.launchpadOptions.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label ?? model.id}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {props.launchpad &&
          supportsReasoning &&
          backend?.launchpadOptions?.reasoningEfforts?.length ? (
            <div className="composer__control-group">
              <label className="composer__control-label" htmlFor="launchpad-reasoning">
                Reasoning
              </label>
              <select
                id="launchpad-reasoning"
                className="composer__select"
                value={props.launchpad.reasoningEffort ?? ""}
                onChange={(event) => {
                  handleLaunchpadPatch({
                    reasoningEffort: event.target.value || undefined,
                  });
                }}
              >
                <option value="">Default</option>
                {backend.launchpadOptions.reasoningEfforts.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {props.launchpad && backend?.launchpadOptions?.serviceTiers?.length ? (
            <div className="composer__control-group">
              <label className="composer__control-label" htmlFor="launchpad-service-tier">
                Service tier
              </label>
              <select
                id="launchpad-service-tier"
                className="composer__select"
                value={props.launchpad.serviceTier ?? ""}
                onChange={(event) => {
                  handleLaunchpadPatch({
                    serviceTier: event.target.value || undefined,
                  });
                }}
              >
                <option value="">Default</option>
                {backend.launchpadOptions.serviceTiers.map((tier) => (
                  <option key={tier} value={tier}>
                    {tier}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {props.launchpad && supportsFast ? (
            <label className="composer__checkbox">
              <input
                checked={Boolean(props.launchpad.fastMode)}
                type="checkbox"
                onChange={(event) => {
                  handleLaunchpadPatch({ fastMode: event.target.checked });
                }}
              />
              <span>Fast mode</span>
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
      ) : props.launchpad ? (
        <p className="composer__meta">
          Changes here become the default for future new-thread launchpads. Existing threads keep their current settings.
        </p>
      ) : null}

      <div className="composer__actions">
        {activeRunId ? (
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

  for (const item of Array.from(clipboardData.items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) {
      continue;
    }

    const file = item.getAsFile();
    if (!file) {
      continue;
    }

    const key = buildFileKey(file);
    if (!seenFiles.has(key)) {
      files.push({ file, type: item.type });
      seenFiles.add(key);
    }
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

function readFileAsDataUrl(file: File, mimeType: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string" && reader.result.startsWith("data:image/")) {
        resolve(reader.result);
        return;
      }

      if (typeof reader.result === "string") {
        const dataSeparatorIndex = reader.result.indexOf(",");
        if (mimeType.startsWith("image/") && dataSeparatorIndex >= 0) {
          resolve(`data:${mimeType};base64,${reader.result.slice(dataSeparatorIndex + 1)}`);
          return;
        }
      }

      reject(new Error("The pasted image did not produce an image data URL."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("The pasted image could not be read."));
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
