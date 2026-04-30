import {
  forwardRef,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import type { AppServerSkillSummary } from "@pwragnt/shared";
import { SkillChip } from "./SkillChip";

export type ComposerSkillToken = AppServerSkillSummary & {
  id: string;
  index: number;
};

type ComposerRichInputProps = {
  disabled?: boolean;
  id: string;
  label: string;
  onChange: (value: string) => void;
  onClick?: () => void;
  onDragOver?: (event: DragEvent<HTMLTextAreaElement>) => void;
  onDrop?: (event: DragEvent<HTMLTextAreaElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onRemoveSkillToken: (id: string) => void;
  placeholder: string;
  skillTokens: ComposerSkillToken[];
  value: string;
};

export const ComposerRichInput = forwardRef<
  HTMLTextAreaElement,
  ComposerRichInputProps
>(function ComposerRichInput(props, ref) {
  return (
    <div
      className={`composer-rich-input${props.disabled ? " is-disabled" : ""}`}
      data-testid="composer-rich-input"
    >
      {props.skillTokens.length > 0 ? (
        <div className="composer-rich-input__chips" aria-label="Selected skills">
          {props.skillTokens.map((skill) => (
            <SkillChip
              key={skill.id}
              label={`$${skill.name}`}
              onRemove={() => props.onRemoveSkillToken(skill.id)}
              skill={skill}
            />
          ))}
        </div>
      ) : null}
      <textarea
        ref={ref}
        id={props.id}
        aria-label={props.label}
        className="composer__input composer-rich-input__textarea"
        disabled={props.disabled}
        placeholder={props.placeholder}
        value={props.value}
        onChange={(event) => {
          props.onChange(event.target.value);
        }}
        onPaste={props.onPaste}
        onDragOver={props.onDragOver}
        onDrop={props.onDrop}
        onClick={props.onClick}
        onKeyDown={props.onKeyDown}
      />
    </div>
  );
});
