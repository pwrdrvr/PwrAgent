import { useEffect, useRef, useState, type KeyboardEvent } from "react";

/**
 * Quick-pick reaction groups, organized by row. Reactions are content
 * (literal emoji), not iconography — explicit exception to the no-emoji-as-icon
 * rule documented in docs/UI-THEME.md.
 *
 * Persistence accepts any string, so any emoji the user types into the
 * "Custom emoji" input below also works (open the macOS emoji panel with
 * Cmd+Ctrl+Space while focused there).
 */
const REACTION_GROUPS: { label: string; emojis: string[] }[] = [
  {
    label: "Status",
    emojis: ["👀", "✋", "✅", "❌", "😢", "🚀", "🎉", "🙏"],
  },
  {
    label: "Numbers",
    emojis: ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"],
  },
  {
    label: "Letters",
    emojis: ["🇦", "🇧", "🇨", "🇩", "🇪", "🇫"],
  },
];

type ReactionPickerProps = {
  open: boolean;
  /** Emoji currently present on the thread; shown as toggled-on. */
  current: string[];
  onSelect: (emoji: string) => void;
  onDismiss: () => void;
};

export function ReactionPicker(props: ReactionPickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [customDraft, setCustomDraft] = useState("");

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

  const handleOptionKey = (
    event: KeyboardEvent<HTMLButtonElement>,
    emoji: string,
  ): void => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      props.onSelect(emoji);
    }
  };

  const submitCustom = (): void => {
    const trimmed = customDraft.trim();
    if (!trimmed) {
      return;
    }
    props.onSelect(trimmed);
    setCustomDraft("");
  };

  return (
    <div
      ref={ref}
      className="reaction-picker"
      role="menu"
      aria-label="Add reaction"
      onClick={(event) => event.stopPropagation()}
    >
      {REACTION_GROUPS.map((group) => (
        <div
          key={group.label}
          className="reaction-picker__row"
          role="group"
          aria-label={group.label}
        >
          {group.emojis.map((emoji) => {
            const isOn = props.current.includes(emoji);
            return (
              <button
                key={emoji}
                type="button"
                role="menuitemradio"
                aria-checked={isOn}
                className={`reaction-picker__option${isOn ? " is-active" : ""}`}
                onClick={() => props.onSelect(emoji)}
                onKeyDown={(event) => handleOptionKey(event, emoji)}
              >
                <span aria-hidden="true">{emoji}</span>
              </button>
            );
          })}
        </div>
      ))}

      <div className="reaction-picker__custom" role="group" aria-label="Custom emoji">
        <input
          type="text"
          aria-label="Custom emoji (Cmd+Ctrl+Space to open emoji keyboard)"
          className="reaction-picker__custom-input"
          maxLength={8}
          placeholder="Custom… (⌘⌃Space)"
          value={customDraft}
          onChange={(event) => setCustomDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submitCustom();
            }
          }}
        />
        <button
          type="button"
          className="reaction-picker__custom-submit"
          disabled={customDraft.trim().length === 0}
          onClick={submitCustom}
        >
          Add
        </button>
      </div>
    </div>
  );
}
