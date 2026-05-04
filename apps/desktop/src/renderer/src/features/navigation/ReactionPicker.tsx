import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

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
    emojis: [
      "0️⃣",
      "1️⃣",
      "2️⃣",
      "3️⃣",
      "4️⃣",
      "5️⃣",
      "6️⃣",
      "7️⃣",
      "8️⃣",
      "9️⃣",
      "🔟",
    ],
  },
  {
    // Negative-circled Latin capitals (U+1F150-…). Render as solid black
    // chips with a white letter — matches the visual weight of the keycap
    // numbers above. Regional-indicator letters (🇦 🇧 …) were tried first
    // but render extremely faintly when used singly, so they're skipped.
    label: "Letters",
    emojis: ["🅐", "🅑", "🅒", "🅓", "🅔", "🅕", "🅖", "🅗", "🅘", "🅙", "🅚"],
  },
];

type ReactionPickerProps = {
  open: boolean;
  /** Emoji currently present on the thread; shown as toggled-on. */
  current: string[];
  /** Element whose top-edge the picker anchors to (the add-reaction button). */
  anchorRef: React.RefObject<HTMLElement | null>;
  onSelect: (emoji: string) => void;
  onDismiss: () => void;
};

type PickerPosition = { top: number; left: number };

export function ReactionPicker(props: ReactionPickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [customDraft, setCustomDraft] = useState("");
  const [position, setPosition] = useState<PickerPosition>();

  // The picker is portaled to <body> with position:fixed because the sidebar
  // scroll container clips overflow on both axes — an absolute child loses
  // its rightmost emoji to the clip box. Anchor by computing rect from the
  // add-reaction button on open and on layout changes.
  useLayoutEffect(() => {
    if (!props.open) {
      setPosition(undefined);
      return;
    }
    const update = (): void => {
      const anchor = props.anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      setPosition({ top: rect.bottom + 6, left: rect.left });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, { capture: true });
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, { capture: true });
    };
  }, [props.open, props.anchorRef]);

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

  if (!props.open || !position) {
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

  return createPortal(
    <div
      ref={ref}
      className="reaction-picker"
      role="menu"
      aria-label="Add reaction"
      style={{ top: position.top, left: position.left }}
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
    </div>,
    document.body,
  );
}
