import { useEffect, useMemo, useRef, useState } from "react";
import type { AppServerSkillSummary, NavigationThreadSummary } from "@pwragnt/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  findSkillTrigger,
  hydrateSkillLabelsWithMarkdown,
  insertSkillLabel,
  listMentionedSkills,
} from "../../lib/skill-mentions";
import { SkillChip } from "./SkillChip";

type ComposerProps = {
  addOptimisticUserMessage?: (text: string) => string;
  desktopApi?: DesktopApi;
  disabled?: boolean;
  onPendingStatusChange?: (status?: string) => void;
  onRefresh: () => Promise<void>;
  removeOptimisticMessage?: (id: string) => void;
  skillError?: string;
  skillLoading?: boolean;
  skills: AppServerSkillSummary[];
  thread?: NavigationThreadSummary;
};

export function Composer(props: ComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string>();
  const [activeSkillIndex, setActiveSkillIndex] = useState(0);
  const [activeOptimisticMessageId, setActiveOptimisticMessageId] = useState<string>();

  const selectionStart = inputRef.current?.selectionStart ?? draft.length;
  const selectionEnd = inputRef.current?.selectionEnd ?? draft.length;
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
  }, [trigger?.query, props.thread?.id]);

  useEffect(() => {
    if (!props.desktopApi?.onAgentEvent || !props.thread) {
      return;
    }

    return props.desktopApi.onAgentEvent((event) => {
      if (event.backend !== props.thread?.source) {
        return;
      }

      if (event.notification.params.threadId !== props.thread.id) {
        return;
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
        setActiveOptimisticMessageId(undefined);
        void props.onRefresh();
      }
    });
  }, [
    activeOptimisticMessageId,
    props.desktopApi,
    props.onPendingStatusChange,
    props.onRefresh,
    props.removeOptimisticMessage,
    props.thread
  ]);

  const submitTurn = async (): Promise<void> => {
    const text = hydrateSkillLabelsWithMarkdown(draft.trim(), mentionedSkills);
    if (!text || !props.thread || !props.desktopApi?.startTurn || props.disabled) {
      return;
    }

    setSendError(undefined);
    setSending(true);
    props.onPendingStatusChange?.("Thinking");
    const optimisticMessageId = props.addOptimisticUserMessage?.(text);
    setActiveOptimisticMessageId(optimisticMessageId);

    try {
      const response = await props.desktopApi.startTurn({
        backend: props.thread.source,
        threadId: props.thread.id,
        input: [{ type: "text", text }],
      });
      setDraft("");
      await props.onRefresh();
    } catch (error) {
      if (optimisticMessageId) {
        props.removeOptimisticMessage?.(optimisticMessageId);
      }
      props.onPendingStatusChange?.(undefined);
      setSending(false);
      setActiveOptimisticMessageId(undefined);
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

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submitTurn();
      }}
    >
      <label className="composer__label" htmlFor="thread-composer">
        Reply
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
          placeholder="Reply to this thread"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setSendError(undefined);
          }}
          onClick={() => {
            setActiveSkillIndex(0);
          }}
          onKeyDown={(event) => {
            if (!hasAutocomplete) {
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

      {props.skillError ? <p className="composer__meta composer__meta--error">{props.skillError}</p> : null}
      {sendError ? <p className="composer__meta composer__meta--error">{sendError}</p> : null}
      {!props.skillError && props.skillLoading ? (
        <p className="composer__meta">Loading skills…</p>
      ) : null}
      {props.disabled ? (
        <p className="composer__meta">
          This thread's backend is unavailable right now. You can keep drafting, but send is unavailable.
        </p>
      ) : null}

      <div className="composer__actions">
        <button
          className="button button--primary"
          disabled={props.disabled || sending || !draft.trim()}
          type="submit"
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </form>
  );
}
