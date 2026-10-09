import { useLayoutEffect, useRef, useState } from "react";

/**
 * A thread title, edited in place. Return saves and Escape cancels; leaving
 * the field saves, as in Finder. A blank or unchanged name is a cancel, so
 * clearing the field and clicking away puts the old title back.
 *
 * `onCommit` receives the new name, or `null` for no change, exactly once.
 */
export function InlineRenameInput(props: {
  initialValue: string;
  className: string;
  ariaLabel: string;
  onCommit: (name: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(props.initialValue);
  const doneRef = useRef(false);

  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const finish = (name: string | null): void => {
    if (doneRef.current) return;
    doneRef.current = true;
    const trimmed = name?.trim() ?? "";
    props.onCommit(trimmed === "" || trimmed === props.initialValue ? null : trimmed);
  };

  return (
    <input
      ref={inputRef}
      aria-label={props.ariaLabel}
      className={props.className}
      spellCheck={false}
      type="text"
      value={value}
      onBlur={() => finish(value)}
      onChange={(event) => setValue(event.target.value)}
      // The row and the title strip both act on clicks and drags; the field
      // keeps them for placing the caret and selecting text.
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          finish(value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(null);
        } else if (
          (event.key === "ArrowLeft" || event.key === "ArrowRight")
          && !event.altKey
          && !event.ctrlKey
          && !event.metaKey
          && !event.shiftKey
          && event.currentTarget.selectionStart === 0
          && event.currentTarget.selectionEnd === event.currentTarget.value.length
        ) {
          // The whole name starts selected; an arrow puts the caret at that
          // end, as a text field does on macOS.
          event.preventDefault();
          const caret = event.key === "ArrowLeft" ? 0 : event.currentTarget.value.length;
          event.currentTarget.setSelectionRange(caret, caret);
        }
      }}
    />
  );
}
