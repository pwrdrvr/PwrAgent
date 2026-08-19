import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { ThreadExecutionMode } from "@pwragent/shared";
import { ComposerTiptapInput } from "./ComposerTiptapInput";
import type { ComposerSkillToken } from "./ComposerInputTypes";

export type CompactComposerAction = {
  disabled?: boolean;
  key: string;
  label: string;
  onSelect: () => void;
};

export type CompactComposerProps = {
  busy?: boolean;
  /**
   * Whether a send during a live turn can reach the backend at all. False
   * disables the primary button while busy rather than letting the operator
   * fire a send that is guaranteed to bounce.
   */
  canSteer?: boolean;
  disabled?: boolean;
  executionMode?: ThreadExecutionMode;
  /** Thread's current model, shown as ambient state rather than a control. */
  model?: string;
  onInterrupt?: () => void;
  /**
   * Resolve `false` to hand the text back to the input — a send that never
   * reached the backend must not cost the operator what they typed.
   */
  onSend: (text: string) => void | boolean | Promise<boolean | void>;
  placeholder?: string;
  reasoningEffort?: string;
  /** Consolidated under the kebab; the row itself stays one line tall. */
  secondaryActions?: CompactComposerAction[];
  threadTitle: string;
};

const EXECUTION_MODE_LABELS: Record<ThreadExecutionMode, string> = {
  default: "Default",
  "full-access": "Full access",
};

/**
 * Module-level so the identity is stable: the Tiptap input re-syncs its
 * document whenever this prop changes identity, and a fresh `[]` on every
 * render would make that run on every keystroke.
 */
const NO_SKILL_TOKENS: ComposerSkillToken[] = [];

/**
 * Composer for surfaces with no vertical budget — currently the star map's
 * floating chat cards.
 *
 * This is deliberately NOT a variant of `Composer.tsx`. That component is
 * ~12,000 lines and needs the backend list, skills, directories,
 * launchpad state, and provider defaults that a floating card has no
 * access to. The two share a contract (send text, stop a running turn),
 * not an implementation.
 *
 * It does share the *input*: `ComposerTiptapInput` in markdown mode, the
 * same editor the full composer types into. A card that renders a fully
 * formatted transcript but takes replies through a plain textarea teaches
 * the operator that backticks and fences do not work here, which is the
 * opposite of true. The editor is not the expensive part of a card — each
 * one already mounts a whole `TranscriptList` — so cards mount it eagerly
 * rather than hydrating it on focus, which would cost a click and a caret
 * every time the operator moved between cards.
 *
 * Mentions are the one thing left out: `$skill`, `@file`, and `#thread`
 * need the backend list and directory index the card does not have, so no
 * skill tokens are ever supplied and the trigger characters stay literal.
 *
 * Two moves buy back the height: secondary actions consolidate under a
 * single kebab, and model / reasoning effort render as right-aligned
 * ambient text *inside* the input rather than as chips below it — they are
 * state to be aware of, not controls to reach for.
 */
export function CompactComposer(props: CompactComposerProps) {
  const [draft, setDraft] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const { onSend } = props;
  // Several cards can be open at once and the editor puts this on a DOM
  // `id`; a shared literal would give the map duplicate ids.
  const inputId = `compact-composer-${useId()}`;

  const ambient = [
    props.model,
    props.reasoningEffort,
    props.executionMode ? EXECUTION_MODE_LABELS[props.executionMode] : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    // Clear optimistically so the input frees up immediately, then put the
    // text back if the send turned out to fail.
    setDraft("");
    const delivered = await onSend(text);
    if (delivered === false) {
      setDraft((current) => (current.length > 0 ? current : text));
    }
  }, [draft, onSend]);

  // The editor forwards only the keys it does not claim itself: Enter
  // without Shift or Alt (both of which insert a newline), and the arrows.
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Enter" || event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      void send();
    },
    [send],
  );

  // Click-away and Escape close the kebab. Without this the menu survives
  // a click on the transcript behind it and covers the conversation.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const actions = props.secondaryActions ?? [];

  return (
    <div className="compact-composer">
      <div className="compact-composer__field">
        <ComposerTiptapInput
          disabled={props.disabled}
          id={inputId}
          label={`Message ${props.threadTitle}`}
          markdownConversion
          onChange={(value) => setDraft(value)}
          onKeyDown={onKeyDown}
          placeholder={props.placeholder ?? "Reply…"}
          skillTokens={NO_SKILL_TOKENS}
          value={draft}
        />
        {ambient ? (
          // Ambient, not interactive: the label belongs to the input, so
          // screen readers reach it through the field rather than as a
          // separate stop.
          <span aria-hidden="true" className="compact-composer__ambient">
            {ambient}
          </span>
        ) : null}
      </div>

      <div className="compact-composer__controls">
        {actions.length > 0 ? (
          <div className="compact-composer__menu" ref={menuRef}>
            <button
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-label="More actions"
              className="compact-composer__kebab"
              onClick={() => setMenuOpen((open) => !open)}
              type="button"
            >
              ⋯
            </button>
            {menuOpen ? (
              <div className="compact-composer__menu-list" role="menu">
                {actions.map((action) => (
                  <button
                    className="compact-composer__menu-item"
                    disabled={action.disabled}
                    key={action.key}
                    onClick={() => {
                      setMenuOpen(false);
                      action.onSelect();
                    }}
                    role="menuitem"
                    type="button"
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {props.busy && props.onInterrupt ? (
          <button
            className="compact-composer__stop"
            onClick={props.onInterrupt}
            type="button"
          >
            Stop
          </button>
        ) : null}
        {/* A live turn used to leave Stop as the only control, which read as
            "you cannot say anything until this finishes". Sending stays
            available and becomes a steer; the host reports back whether the
            backend took it into the running turn or held it for the next. */}
        <button
          className="compact-composer__send"
          disabled={
            props.disabled
            || draft.trim().length === 0
            || (props.busy && props.canSteer === false)
          }
          onClick={() => void send()}
          type="button"
        >
          {props.busy ? "Steer" : "Send"}
        </button>
      </div>
    </div>
  );
}
