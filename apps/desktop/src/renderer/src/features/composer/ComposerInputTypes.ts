import type { JSONContent } from "@tiptap/react";
import type { AppServerSkillSummary } from "@pwragent/shared";

/**
 * A zero-width mention token anchored at a plain-draft character offset.
 * Despite the name (which predates the other kinds), the token array
 * carries ALL mention kinds the composer supports:
 *   - skills (default, `kind` absent): `name`/`path` describe a skill;
 *     serializes to `[$name](path)` markdown.
 *   - directory references (`kind: "directory"`): `name` is the tracked
 *     directory's label and `path` its absolute path; serializes to
 *     `[@label](~/path)` markdown in the outgoing text.
 *   - file references (`kind: "file"`): `name` is the file's basename and
 *     `path` its absolute file path; serializes to the same
 *     `[@label](~/path)` markdown as directory references.
 */
export type ComposerSkillToken = AppServerSkillSummary & {
  id: string;
  index: number;
  kind?: "directory" | "file";
};

export type ComposerInputChangeMetadata = {
  editorDocument?: JSONContent;
};

export type ComposerInputHandle = {
  deleteSelection: () => void;
  focus: () => void;
  readonly selectionEnd: number;
  readonly selectionStart: number;
  readonly skillTokenCount: number;
  readonly value: string;
  setSelectionRange: (start: number, end: number) => void;
};
