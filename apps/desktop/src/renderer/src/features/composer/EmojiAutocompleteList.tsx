import type { KeyboardEvent as ReactKeyboardEvent, MutableRefObject, RefObject } from "react";
import type { ReactionEmojiEntry } from "../navigation/reaction-picker-model";
import { HighlightedAutocompleteLabel } from "./HighlightedAutocompleteLabel";

type EmojiAutocompleteListProps = {
  activeIndex: number;
  listboxId: string;
  listRef: RefObject<HTMLDivElement | null>;
  maxHeight: number;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  onSelect: (entry: ReactionEmojiEntry) => void;
  onSetActiveIndex: (index: number) => void;
  optionRefs: MutableRefObject<Array<HTMLButtonElement | null>>;
  options: readonly ReactionEmojiEntry[];
  placement: "above" | "below";
  query: string;
};

export function EmojiAutocompleteList(props: EmojiAutocompleteListProps) {
  return (
    <div
      className={`composer__autocomplete composer__autocomplete--emoji composer__autocomplete--${props.placement}`}
      ref={props.listRef}
      role="listbox"
      aria-label="Emoji"
      id={props.listboxId}
      style={{ maxHeight: props.maxHeight }}
    >
      {props.options.map((entry, index) => (
        <button
          key={`${entry.shortcode}:${entry.emoji}`}
          id={`${props.listboxId}-option-${index}`}
          ref={(node) => {
            props.optionRefs.current[index] = node;
          }}
          aria-selected={index === props.activeIndex}
          className={`composer__autocomplete-option${index === props.activeIndex ? " is-active" : ""}`}
          role="option"
          tabIndex={index === props.activeIndex ? 0 : -1}
          type="button"
          onMouseDown={(event) => {
            event.preventDefault();
            props.onSelect(entry);
          }}
          onClick={() => {
            props.onSelect(entry);
          }}
          onFocus={() => {
            props.onSetActiveIndex(index);
          }}
          onKeyDown={props.onKeyDown}
        >
          <span className="composer__autocomplete-emoji" aria-hidden="true">
            {entry.emoji}
          </span>
          <span className="composer__autocomplete-emoji-shortcode">
            <HighlightedAutocompleteLabel
              label={`:${entry.shortcode}:`}
              matchAnywhere
              query={props.query}
            />
          </span>
          <span className="composer__autocomplete-emoji-name">
            {entry.name}
          </span>
        </button>
      ))}
    </div>
  );
}
