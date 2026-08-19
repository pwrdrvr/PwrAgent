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
 *   - thread references (`kind: "thread"`): `name` is the resolved thread
 *     title and `path` its canonical `pwragent://thread/...` URL; serializes
 *     to the same Markdown link the transcript recognizes as a thread chip.
 *   - pull-request references (`kind: "pull-request"`): `name` is the short
 *     `#123` label and `path` the repository-scoped PR URL; serializes to the
 *     Markdown link the transcript hydrates into its live PR chip.
 */
export type ComposerSkillToken = AppServerSkillSummary & {
  id: string;
  index: number;
  kind?: "directory" | "file" | "pull-request" | "thread";
  /**
   * Pull-request chips only: the `pr-chip--*` modifiers the sidebar chip would
   * render for this PR, resolved when the token was minted. The composer draws
   * its chips through Tiptap DOM specs, which cannot mount `PrChip`, so the
   * status has to travel with the token or the chip renders permanently gray.
   * Absent only on a chip restored from an editor document saved before chips
   * carried their status; those keep rendering the gray "unknown" dot.
   */
  prChipModifiers?: string[];
};

export type ComposerInputChangeMetadata = {
  editorDocument?: JSONContent;
};

export type ComposerInputHandle = {
  deleteSelection: () => void;
  focus: () => void;
  insertMentionToken: (token: ComposerSkillToken) => boolean;
  readonly selectionEnd: number;
  readonly selectionStart: number;
  readonly skillTokenCount: number;
  readonly value: string;
  setSelectionRange: (start: number, end: number) => void;
};
