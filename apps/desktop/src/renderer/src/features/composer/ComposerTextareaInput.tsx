import {
  forwardRef,
  useImperativeHandle,
  useRef,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import type { ComposerRichInputHandle } from "./ComposerRichInput";

type ComposerTextareaInputProps = {
  ariaActiveDescendant?: string;
  ariaControls?: string;
  ariaExpanded?: boolean;
  disabled?: boolean;
  id: string;
  label: string;
  onChange: (value: string) => void;
  onClick?: (event: MouseEvent<HTMLTextAreaElement>) => void;
  onDragOver?: (event: DragEvent<HTMLTextAreaElement>) => void;
  onDrop?: (event: DragEvent<HTMLTextAreaElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  placeholder: string;
  value: string;
};

export const ComposerTextareaInput = forwardRef<
  ComposerRichInputHandle,
  ComposerTextareaInputProps
>(function ComposerTextareaInput(props, ref) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    deleteSelection: (direction) => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      if (start !== end) {
        textarea.setRangeText("", start, end, "start");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }

      const deleteStart =
        direction === "backward" ? Math.max(0, start - 1) : start;
      const deleteEnd =
        direction === "backward" ? start : Math.min(textarea.value.length, start + 1);
      if (deleteStart === deleteEnd) {
        return;
      }

      textarea.setRangeText("", deleteStart, deleteEnd, "start");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    },
    focus: () => {
      textareaRef.current?.focus();
    },
    get selectionEnd() {
      return textareaRef.current?.selectionEnd ?? props.value.length;
    },
    get selectionStart() {
      return textareaRef.current?.selectionStart ?? props.value.length;
    },
    setSelectionRange: (start: number, end: number) => {
      textareaRef.current?.setSelectionRange(start, end);
    },
  }));

  return (
    <textarea
      ref={textareaRef}
      id={props.id}
      aria-activedescendant={props.ariaActiveDescendant}
      aria-controls={props.ariaControls}
      aria-expanded={props.ariaExpanded}
      aria-label={props.label}
      className="composer__input"
      data-testid="composer-textarea-input"
      disabled={props.disabled}
      placeholder={props.placeholder}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      onClick={props.onClick}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
      onKeyDown={props.onKeyDown}
      onPaste={props.onPaste}
    />
  );
});
