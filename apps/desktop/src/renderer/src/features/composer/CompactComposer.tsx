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
import {
  useComposerMentions,
  type ComposerMentionSources,
} from "./useComposerMentions";

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
  /**
   * Populations the `$` / `@` / `#` popovers pick from. Optional on
   * purpose: a host that supplies nothing keeps the trigger characters as
   * literal prose, so adopting this component never requires them.
   */
  mentionSources?: ComposerMentionSources;
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
 * It does share the *input*: `ComposerTiptapInput` in markdown mode, the
 * same editor the full composer types into. A card that renders a fully
 * formatted transcript but takes replies through a plain textarea teaches
 * the operator that backticks and fences do not work here, which is the
 * opposite of true. The editor is not the expensive part of a card — each
 * one already mounts a whole `TranscriptList` — so cards mount it eagerly
 * rather than hydrating it on focus, which would cost a click and a caret
 * every time the operator moved between cards.
 *
 * Mentions come from `useComposerMentions`, driven by whatever populations
 * the host can honestly supply through `mentionSources`. Nothing about the
 * pickers is re-implemented here: the triggers, ranking, token minting and
 * markdown serialization are the same modules the full composer calls.
 *
 * Two moves buy back the height: secondary actions consolidate under a
 * single kebab, and model / reasoning effort render as right-aligned
 * ambient text *inside* the input rather than as chips below it — they are
 * state to be aware of, not controls to reach for.
 */
export function CompactComposer(props: CompactComposerProps) {
  const mentions = useComposerMentions({ sources: props.mentionSources });
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
    // The serialized text, not the plain draft: a mention chip is
    // zero-width until this splices its markdown back in.
    const text = mentions.text.trim();
    if (!text) return;
    // Clear optimistically so the input frees up immediately, then put the
    // draft back — chips and all — if the send turned out to fail.
    const previous = mentions.snapshot;
    mentions.clear();
    const delivered = await onSend(text);
    if (delivered === false) {
      mentions.restore(previous);
    }
  }, [mentions, onSend]);

  // The editor forwards the keys it does not claim itself: Enter without
  // Shift or Alt (both of which insert a newline), the arrows, and anything
  // it has no binding for — Escape and Tab among them.
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      // An open mention popover claims the arrows, Enter, Tab, and Escape
      // before the send path sees them.
      if (mentions.handleKeyDown(event)) return;
      if (event.key !== "Enter" || event.metaKey || event.ctrlKey) return;
      // The button checks this too. A disabled `<textarea>` used to swallow
      // the keydown for us; the editor only stops taking new text, and still
      // forwards Enter from a field that was focused before it was disabled.
      if (props.disabled) return;
      event.preventDefault();
      void send();
    },
    [mentions, props.disabled, send],
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
          ref={mentions.inputRef}
          ariaActiveDescendant={mentions.activeOptionId}
          ariaControls={mentions.listboxId}
          ariaExpanded={mentions.open}
          disabled={props.disabled}
          id={inputId}
          label={`Message ${props.threadTitle}`}
          markdownConversion
          onChange={mentions.handleChange}
          onKeyDown={onKeyDown}
          placeholder={props.placeholder ?? "Reply…"}
          skillTokens={mentions.skillTokens}
          value={mentions.draft}
        />
        {/* Inside the field, not portalled to the body: on the star map
            that is what keeps the list within `.star-map-chat-card`, the
            selector every camera-gesture guard tests against. */}
        {mentions.popover}
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
            || mentions.text.trim().length === 0
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
