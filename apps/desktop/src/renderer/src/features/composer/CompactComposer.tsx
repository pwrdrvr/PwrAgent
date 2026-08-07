import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { ThreadExecutionMode } from "@pwragent/shared";

export type CompactComposerAction = {
  disabled?: boolean;
  key: string;
  label: string;
  onSelect: () => void;
};

export type CompactComposerProps = {
  busy?: boolean;
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
 * Composer for surfaces with no vertical budget — currently the star map's
 * floating chat cards.
 *
 * This is deliberately NOT a variant of `Composer.tsx`. That component is
 * ~12,000 lines and needs the backend list, skills, directories,
 * launchpad state, and provider defaults that a floating card has no
 * access to. The two share a contract (send text, stop a running turn),
 * not an implementation.
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

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void send();
      }
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
        <textarea
          aria-label={`Message ${props.threadTitle}`}
          className="compact-composer__input"
          disabled={props.disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={props.placeholder ?? "Reply…"}
          rows={2}
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

        {props.busy ? (
          <button
            className="compact-composer__send"
            onClick={props.onInterrupt}
            type="button"
          >
            Stop
          </button>
        ) : (
          <button
            className="compact-composer__send"
            disabled={props.disabled || draft.trim().length === 0}
            onClick={() => void send()}
            type="button"
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
