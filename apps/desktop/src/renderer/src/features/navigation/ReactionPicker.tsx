import { useEffect, useRef, type KeyboardEvent } from "react";

/**
 * Common reactions for the quick-pick popover. These are the markers the
 * user is most likely to use to triage threads ("looking", "done", "broken",
 * "in trouble", "shipping", "celebrating"). The picker order is intentional
 * — eyes first because "I need to come back to this" is the most common use.
 *
 * Reactions are content (emoji literally), not iconography — exception
 * to the no-emoji-as-icon rule documented in docs/UI-THEME.md.
 */
export const QUICK_REACTIONS = ["👀", "✅", "❌", "😢", "🚀", "🎉"];

type ReactionPickerProps = {
  open: boolean;
  /** Emoji currently present on the thread; shown as toggled-on. */
  current: string[];
  onSelect: (emoji: string) => void;
  onDismiss: () => void;
};

export function ReactionPicker(props: ReactionPickerProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!props.open) {
      return;
    }
    const handlePointerDown = (event: PointerEvent): void => {
      if (!ref.current?.contains(event.target as Node | null)) {
        props.onDismiss();
      }
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        props.onDismiss();
      }
    };
    window.addEventListener("pointerdown", handlePointerDown, { capture: true });
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, {
        capture: true,
      });
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [props.open, props.onDismiss, props]);

  if (!props.open) {
    return null;
  }

  const handleKey = (event: KeyboardEvent<HTMLButtonElement>, emoji: string): void => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      props.onSelect(emoji);
    }
  };

  return (
    <div
      ref={ref}
      className="reaction-picker"
      role="menu"
      aria-label="Add reaction"
      onClick={(event) => event.stopPropagation()}
    >
      {QUICK_REACTIONS.map((emoji) => {
        const isOn = props.current.includes(emoji);
        return (
          <button
            key={emoji}
            type="button"
            role="menuitemradio"
            aria-checked={isOn}
            className={`reaction-picker__option${isOn ? " is-active" : ""}`}
            onClick={() => props.onSelect(emoji)}
            onKeyDown={(event) => handleKey(event, emoji)}
          >
            <span aria-hidden="true">{emoji}</span>
          </button>
        );
      })}
    </div>
  );
}
