import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { flushSync } from "react-dom";
import Mention from "@tiptap/extension-mention";
import StarterKit from "@tiptap/starter-kit";
import { closeHistory } from "prosemirror-history";
import { EditorContent, useEditor, type JSONContent } from "@tiptap/react";
import type { AppServerSkillSummary } from "@pwragent/shared";
import { buildSkillTooltip, findSkillTrigger } from "../../lib/skill-mentions";
import type {
  ComposerInputChangeMetadata,
  ComposerInputHandle,
  ComposerSkillToken,
} from "./ComposerInputTypes";

type ComposerTiptapInputProps = {
  ariaActiveDescendant?: string;
  ariaControls?: string;
  ariaExpanded?: boolean;
  disabled?: boolean;
  editorDocument?: JSONContent;
  id: string;
  label: string;
  markdownConversion?: boolean;
  onChange: (
    value: string,
    skillTokens?: ComposerSkillToken[],
    metadata?: ComposerInputChangeMetadata,
  ) => void;
  onClick?: (event: MouseEvent<HTMLDivElement>) => void;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
  placeholder: string;
  selectionRequest?: {
    id: string;
    index: number;
  };
  skillTokens: ComposerSkillToken[];
  value: string;
};

type TiptapReadMode = "markdown" | "text";

type TiptapReadState = {
  skillTokens: ComposerSkillToken[];
  value: string;
};

type DeletedSingleSkillState = TiptapReadState & {
  editorDocument: JSONContent;
  selectionIndex: number;
};

type ControlledHistoryEntry = TiptapReadState & {
  editorDocument: JSONContent;
  selectionIndex: number;
};

type TiptapEditor = NonNullable<ReturnType<typeof useEditor>>;
type ProseMirrorNode = Parameters<
  Parameters<TiptapEditor["state"]["doc"]["forEach"]>[0]
>[0];

const SkillMention = Mention.extend({
  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute("data-composer-skill-token-id") ??
          element.getAttribute("data-id"),
      },
      name: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute("data-skill-name") ??
          element.getAttribute("data-label") ??
          element.textContent?.replace(/^\$/, "") ??
          null,
      },
      path: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-skill-path"),
      },
      description: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-skill-description"),
      },
      shortDescription: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute("data-skill-short-description"),
      },
    };
  },
}).configure({
  deleteTriggerWithBackspace: true,
  HTMLAttributes: {
    class: "chip skill-chip composer-tiptap-input__mention",
  },
  renderHTML: ({ node }) => {
    const skill = getSkillSummary(node.attrs);
    const tooltip = buildSkillTooltip(skill);
    return [
      "span",
      {
        class: "chip skill-chip composer-tiptap-input__mention",
        "data-type": "mention",
        "data-composer-skill-token-id": String(node.attrs.id ?? ""),
        "data-id": String(node.attrs.id ?? ""),
        "data-label": skill.name,
        "data-skill-name": skill.name,
        ...(skill.path ? { "data-skill-path": skill.path } : {}),
        ...(skill.description
          ? { "data-skill-description": skill.description }
          : {}),
        ...(skill.shortDescription
          ? { "data-skill-short-description": skill.shortDescription }
          : {}),
        ...(tooltip ? { "data-tooltip": tooltip } : {}),
      },
      `$${skill.name}`,
    ];
  },
  renderText: ({ node }) => `$${String(node.attrs.name ?? node.attrs.id ?? "")}`,
  suggestion: {
    char: "\uFFFF",
    items: () => [],
  },
});

const MarkdownStarterKit = StarterKit.configure({
  link: false,
  undoRedo: {
    depth: 500,
    newGroupDelay: 750,
  },
});

const PlainTextStarterKit = StarterKit.configure({
  blockquote: false,
  bulletList: false,
  codeBlock: false,
  heading: false,
  horizontalRule: false,
  link: false,
  listItem: false,
  orderedList: false,
  undoRedo: {
    depth: 500,
    newGroupDelay: 750,
  },
});

function splitTextContent(text: string): JSONContent[] {
  const nodes: JSONContent[] = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (index > 0) {
      nodes.push({ type: "hardBreak" });
    }
    if (line) {
      nodes.push({ type: "text", text: line });
    }
  });
  return nodes;
}

function isMacPlatform(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(window.navigator.platform);
}

type InlineMarkSpec = {
  delimiter: string;
  mark: "bold" | "italic" | "strike" | "code";
  verbatim?: boolean;
};

// Order matters: longer delimiters must be matched before their prefixes
// (** before *) so we don't misclassify bold as italic-italic.
const INLINE_MARK_SPECS: InlineMarkSpec[] = [
  { delimiter: "**", mark: "bold" },
  { delimiter: "~~", mark: "strike" },
  { delimiter: "`", mark: "code", verbatim: true },
  { delimiter: "*", mark: "italic" },
];

function parseInlineMarkdown(text: string): JSONContent[] {
  return parseInlineMarkdownWithMarks(text, []);
}

function parseInlineMarkdownWithMarks(
  text: string,
  inheritedMarks: { type: string }[],
): JSONContent[] {
  const nodes: JSONContent[] = [];
  let buffer = "";
  let cursor = 0;

  const flush = (): void => {
    if (buffer.length === 0) {
      return;
    }
    nodes.push({
      type: "text",
      text: buffer,
      ...(inheritedMarks.length > 0 ? { marks: inheritedMarks } : {}),
    });
    buffer = "";
  };

  while (cursor < text.length) {
    const char = text[cursor];

    if (char === "\n") {
      flush();
      nodes.push({ type: "hardBreak" });
      cursor += 1;
      continue;
    }

    let matchedSpec: InlineMarkSpec | undefined;
    let closeIndex = -1;
    for (const spec of INLINE_MARK_SPECS) {
      if (!text.startsWith(spec.delimiter, cursor)) {
        continue;
      }
      // Don't match an opener immediately followed by the closing delimiter
      // (empty span) or by whitespace immediately after the opener — that
      // would shadow legitimate uses like `* not a list`.
      const innerStart = cursor + spec.delimiter.length;
      if (innerStart >= text.length) {
        continue;
      }
      const candidateClose = text.indexOf(spec.delimiter, innerStart);
      if (candidateClose === -1 || candidateClose === innerStart) {
        continue;
      }
      matchedSpec = spec;
      closeIndex = candidateClose;
      break;
    }

    if (!matchedSpec) {
      buffer += char;
      cursor += 1;
      continue;
    }

    flush();
    const innerStart = cursor + matchedSpec.delimiter.length;
    const inner = text.slice(innerStart, closeIndex);
    const nextMarks = [...inheritedMarks, { type: matchedSpec.mark }];
    if (matchedSpec.verbatim) {
      nodes.push({
        type: "text",
        text: inner,
        marks: nextMarks,
      });
    } else {
      nodes.push(...parseInlineMarkdownWithMarks(inner, nextMarks));
    }
    cursor = closeIndex + matchedSpec.delimiter.length;
  }

  flush();
  return nodes;
}

function buildTiptapContent(
  value: string,
  skillTokens: ComposerSkillToken[],
  options?: { markdownConversion?: boolean },
): JSONContent {
  if (options?.markdownConversion && skillTokens.length === 0) {
    return buildMarkdownTiptapContent(value);
  }

  const sortedTokens = [...skillTokens].sort((left, right) => {
    if (left.index !== right.index) {
      return left.index - right.index;
    }
    return left.id.localeCompare(right.id);
  });

  const content: JSONContent[] = [];
  let cursor = 0;
  sortedTokens.forEach((skill) => {
    const index = Math.max(0, Math.min(skill.index, value.length));
    content.push(...splitTextContent(value.slice(cursor, index)));
    content.push({
      type: "mention",
      attrs: {
        id: skill.id,
        name: skill.name,
        path: skill.path ?? null,
        description: skill.description ?? null,
        shortDescription: skill.shortDescription ?? null,
      },
    });
    cursor = index;
  });
  content.push(...splitTextContent(value.slice(cursor)));

  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: content.length > 0 ? content : undefined,
      },
    ],
  };
}

function buildMarkdownTiptapContent(value: string): JSONContent {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  const content: JSONContent[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const codeFence = line.match(/^```([A-Za-z0-9_-]*)\s*$/);
    if (codeFence) {
      index += 1;
      const codeLines: string[] = [];
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      content.push({
        type: "codeBlock",
        attrs: { language: codeFence[1] || null },
        content: codeLines.length > 0
          ? [{ type: "text", text: codeLines.join("\n") }]
          : undefined,
      });
      continue;
    }

    // Blank lines between content are paragraph separators in markdown,
    // not standalone empty paragraph nodes. Re-creating them as nodes
    // double-spaces the doc on every round-trip (n → 2n+1 blank lines).
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      (lines[index] ?? "").trim().length > 0 &&
      !/^```([A-Za-z0-9_-]*)\s*$/.test(lines[index] ?? "")
    ) {
      paragraphLines.push(lines[index] ?? "");
      index += 1;
    }
    content.push({
      type: "paragraph",
      content: parseInlineMarkdown(paragraphLines.join("\n")),
    });
  }

  return {
    type: "doc",
    content: content.length > 0 ? content : [{ type: "paragraph" }],
  };
}

function mentionAttrsToSkill(
  attrs: Record<string, unknown>,
  index: number,
): ComposerSkillToken {
  const name = typeof attrs.name === "string" ? attrs.name : String(attrs.id ?? "skill");
  return {
    id: typeof attrs.id === "string" ? attrs.id : `${name}:${index}`,
    index,
    name,
    path: typeof attrs.path === "string" ? attrs.path : undefined,
    description:
      typeof attrs.description === "string" ? attrs.description : undefined,
    shortDescription:
      typeof attrs.shortDescription === "string"
        ? attrs.shortDescription
        : undefined,
  };
}

function getMarkdownMarkDelimiters(
  node: ProseMirrorNode,
): { prefix: string; suffix: string } {
  return node.marks.reduce(
    (delimiters, mark) => {
      if (mark.type.name === "bold") {
        return {
          prefix: `${delimiters.prefix}**`,
          suffix: `**${delimiters.suffix}`,
        };
      }
      if (mark.type.name === "italic") {
        return {
          prefix: `${delimiters.prefix}*`,
          suffix: `*${delimiters.suffix}`,
        };
      }
      if (mark.type.name === "strike") {
        return {
          prefix: `${delimiters.prefix}~~`,
          suffix: `~~${delimiters.suffix}`,
        };
      }
      if (mark.type.name === "code") {
        return {
          prefix: `${delimiters.prefix}\``,
          suffix: `\`${delimiters.suffix}`,
        };
      }
      return delimiters;
    },
    { prefix: "", suffix: "" },
  );
}

function appendMarkdownInlineContent(
  node: ProseMirrorNode,
  state: TiptapReadState,
): void {
  node.forEach((child) => {
    if (child.isText) {
      const delimiters = getMarkdownMarkDelimiters(child);
      state.value += `${delimiters.prefix}${child.text ?? ""}${delimiters.suffix}`;
      return;
    }

    if (child.type.name === "hardBreak") {
      state.value += "\n";
      return;
    }

    if (child.type.name === "mention") {
      state.skillTokens.push(mentionAttrsToSkill(child.attrs, state.value.length));
      return;
    }

    appendMarkdownInlineContent(child, state);
  });
}

function appendMarkdownListItem(
  node: ProseMirrorNode,
  state: TiptapReadState,
): void {
  let wroteFirstBlock = false;
  node.forEach((child) => {
    if (wroteFirstBlock) {
      state.value += "\n  ";
    }
    wroteFirstBlock = true;
    if (child.type.name === "paragraph") {
      appendMarkdownInlineContent(child, state);
      return;
    }
    appendMarkdownBlock(child, state, 0);
  });
}

function appendMarkdownBlock(
  node: ProseMirrorNode,
  state: TiptapReadState,
  index: number,
): void {
  if (index > 0) {
    state.value += "\n\n";
  }

  if (node.type.name === "paragraph") {
    appendMarkdownInlineContent(node, state);
    return;
  }

  if (node.type.name === "heading") {
    const level = typeof node.attrs.level === "number" ? node.attrs.level : 1;
    state.value += `${"#".repeat(Math.min(Math.max(level, 1), 6))} `;
    appendMarkdownInlineContent(node, state);
    return;
  }

  if (node.type.name === "codeBlock") {
    const language = typeof node.attrs.language === "string" ? node.attrs.language : "";
    state.value += `\`\`\`${language}\n${node.textContent}\n\`\`\``;
    return;
  }

  if (node.type.name === "bulletList") {
    node.forEach((child, _offset, listIndex) => {
      if (listIndex > 0) {
        state.value += "\n";
      }
      state.value += "- ";
      appendMarkdownListItem(child, state);
    });
    return;
  }

  if (node.type.name === "orderedList") {
    const start = typeof node.attrs.start === "number" ? node.attrs.start : 1;
    node.forEach((child, _offset, listIndex) => {
      if (listIndex > 0) {
        state.value += "\n";
      }
      state.value += `${start + listIndex}. `;
      appendMarkdownListItem(child, state);
    });
    return;
  }

  if (node.type.name === "blockquote") {
    const quotedState: TiptapReadState = { skillTokens: [], value: "" };
    node.forEach((child, _offset, childIndex) => {
      appendMarkdownBlock(child, quotedState, childIndex);
    });
    const quoteStart = state.value.length;
    state.value += quotedState.value
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    quotedState.skillTokens.forEach((token) => {
      state.skillTokens.push({ ...token, index: quoteStart + token.index + 2 });
    });
    return;
  }

  appendMarkdownInlineContent(node, state);
}

function readTiptapMarkdownContent(
  editor: NonNullable<ReturnType<typeof useEditor>>,
): {
  skillTokens: ComposerSkillToken[];
  value: string;
} {
  const state: TiptapReadState = { skillTokens: [], value: "" };
  const nodes: ProseMirrorNode[] = [];
  editor.state.doc.forEach((node) => {
    nodes.push(node);
  });
  let lastContentIndex = nodes.length - 1;
  while (
    lastContentIndex >= 0 &&
    nodes[lastContentIndex]?.type.name === "paragraph" &&
    nodes[lastContentIndex]?.content.size === 0
  ) {
    lastContentIndex -= 1;
  }
  nodes.slice(0, lastContentIndex + 1).forEach((node, index) => {
    appendMarkdownBlock(node, state, index);
  });
  return state;
}

function readTiptapTextContent(editor: NonNullable<ReturnType<typeof useEditor>>): {
  skillTokens: ComposerSkillToken[];
  value: string;
} {
  let value = "";
  const skillTokens: ComposerSkillToken[] = [];

  editor.state.doc.descendants((node, _pos, parent, index) => {
    if (node.type.name === "paragraph" && parent?.type.name === "doc") {
      if (index > 0) {
        value += "\n";
      }
      return true;
    }

    if (node.isText) {
      value += node.text ?? "";
      return false;
    }

    if (node.type.name === "hardBreak") {
      value += "\n";
      return false;
    }

    if (node.type.name === "mention") {
      skillTokens.push(mentionAttrsToSkill(node.attrs, value.length));
      return false;
    }

    return true;
  });

  return { value, skillTokens };
}

function readTiptapContent(
  editor: NonNullable<ReturnType<typeof useEditor>>,
  mode: TiptapReadMode,
): {
  skillTokens: ComposerSkillToken[];
  value: string;
} {
  return mode === "markdown"
    ? readTiptapMarkdownContent(editor)
    : readTiptapTextContent(editor);
}

function insertWysiwygLineBreak(editor: TiptapEditor): boolean {
  if (editor.state.selection.$from.parent.type.name === "codeBlock") {
    return editor.commands.newlineInCode();
  }

  if (editor.isActive("listItem")) {
    return editor.commands.first(({ commands }) => [
      () => commands.splitListItem("listItem"),
      () => commands.createParagraphNear(),
      () => commands.liftEmptyBlock(),
      () => commands.splitBlock(),
    ]);
  }

  return editor.commands.first(({ commands }) => [
    () => commands.createParagraphNear(),
    () => commands.liftEmptyBlock(),
    () => commands.splitBlock(),
  ]);
}

function insertWysiwygSoftBreak(editor: TiptapEditor): boolean {
  return editor.commands.setHardBreak();
}

function getTrailingComposerToken(text: string): string | undefined {
  return text.match(/(?:^|\s)(\S+)$/)?.[1];
}

function isLinkLikeComposerToken(token: string): boolean {
  const trimmed = token.replace(/[),.;:!?]+$/, "");
  if (/^(?:https?:\/\/|www\.)\S+\.\S+$/i.test(trimmed)) {
    return true;
  }
  if (/^[^\s/]+\/\S+$/.test(trimmed)) {
    return true;
  }
  return /^[^\s/]+\.[A-Za-z]{2,}(?:\/\S*)?$/.test(trimmed);
}

function insertPlainSpaceAtTextblockEnd(editor: TiptapEditor): boolean {
  const { selection } = editor.state;
  if (!selection.empty) {
    return false;
  }

  const currentPos = selection.$from;
  if (currentPos.pos !== currentPos.end()) {
    return false;
  }
  if (currentPos.parent.type.name === "codeBlock") {
    return false;
  }

  const currentMarks = editor.state.storedMarks ?? currentPos.marks();
  const textBeforeCursor = currentPos.parent.textBetween(
    0,
    currentPos.parentOffset,
    undefined,
    "\uFFFC",
  );
  const trailingToken = getTrailingComposerToken(textBeforeCursor);
  if (
    currentMarks.length === 0 &&
    (!trailingToken || !isLinkLikeComposerToken(trailingToken))
  ) {
    return false;
  }

  let transaction = editor.state.tr;
  currentMarks.forEach((mark) => {
    transaction = transaction.removeStoredMark(mark);
  });
  transaction = transaction.insertText(" ", currentPos.pos).scrollIntoView();
  editor.view.dispatch(transaction);
  return true;
}

function getPlainTextFromPaste(event: ClipboardEvent<HTMLDivElement>): string {
  return event.clipboardData?.getData("text/plain").replace(/\r\n?/g, "\n") ?? "";
}

function selectionIsInsideNode(editor: TiptapEditor, nodeTypeName: string): boolean {
  const { $from, $to } = editor.state.selection;
  const isInside = ($pos: typeof $from): boolean => {
    for (let depth = $pos.depth; depth >= 0; depth -= 1) {
      if ($pos.node(depth).type.name === nodeTypeName) {
        return true;
      }
    }
    return false;
  };

  return isInside($from) && isInside($to);
}

function pastePlainTextIntoActiveBlock(
  editor: TiptapEditor,
  event: ClipboardEvent<HTMLDivElement>,
): boolean {
  const text = getPlainTextFromPaste(event);
  if (!text) {
    return false;
  }

  if (
    editor.state.selection.$from.parent.type.name === "codeBlock" &&
    editor.state.selection.$to.parent.type.name === "codeBlock"
  ) {
    event.preventDefault();
    const { from, to } = editor.state.selection;
    editor.view.dispatch(editor.state.tr.insertText(text, from, to).scrollIntoView());
    return true;
  }

  if (selectionIsInsideNode(editor, "blockquote")) {
    event.preventDefault();
    return editor.commands.insertContent(splitTextContent(text), {
      updateSelection: true,
    });
  }

  return false;
}

function getCodeBlockMarkdownParts(node: ProseMirrorNode): {
  contentLength: number;
  prefixLength: number;
  totalLength: number;
} {
  const language = typeof node.attrs.language === "string" ? node.attrs.language : "";
  const prefixLength = `\`\`\`${language}\n`.length;
  const contentLength = node.textContent.length;
  const suffixLength = "\n```".length;
  return {
    contentLength,
    prefixLength,
    totalLength: prefixLength + contentLength + suffixLength,
  };
}

function getMarkdownBlockPrefixLength(
  node: ProseMirrorNode,
  parent: ProseMirrorNode | null,
  childIndex: number,
): number {
  if (parent?.type.name === "doc" && node.type.name === "heading") {
    const level = typeof node.attrs.level === "number" ? node.attrs.level : 1;
    return `${"#".repeat(Math.min(Math.max(level, 1), 6))} `.length;
  }

  if (parent?.type.name === "bulletList" && node.type.name === "listItem") {
    return `${childIndex > 0 ? "\n" : ""}- `.length;
  }

  if (parent?.type.name === "orderedList" && node.type.name === "listItem") {
    const start = typeof parent.attrs.start === "number" ? parent.attrs.start : 1;
    return `${childIndex > 0 ? "\n" : ""}${start + childIndex}. `.length;
  }

  if (parent?.type.name === "listItem" && childIndex > 0) {
    return "\n  ".length;
  }

  return 0;
}

function getDraftIndexAtPosition(
  editor: NonNullable<ReturnType<typeof useEditor>>,
  position: number,
  mode: TiptapReadMode,
): number {
  let index = 0;
  let found = false;

  editor.state.doc.descendants((node, pos, parent, childIndex) => {
    if (found) {
      return false;
    }

    if (parent?.type.name === "doc") {
      if (position <= pos) {
        found = true;
        return false;
      }
      if (childIndex > 0) {
        index += mode === "markdown" ? 2 : 1;
      }
      if (mode === "markdown" && node.type.name === "codeBlock") {
        const codeBlock = getCodeBlockMarkdownParts(node);
        const nodeEnd = pos + node.nodeSize;
        if (position >= nodeEnd) {
          index += codeBlock.totalLength;
          return false;
        }
        index += codeBlock.prefixLength;
        return true;
      }
      if (position <= pos + 1) {
        found = true;
        return false;
      }
    }

    if (mode === "markdown") {
      const prefixLength = getMarkdownBlockPrefixLength(node, parent, childIndex);
      if (prefixLength > 0) {
        if (position <= pos + 1) {
          index += prefixLength;
          found = true;
          return false;
        }
        index += prefixLength;
      }
    }

    if (node.isText) {
      const text = node.text ?? "";
      const end = pos + text.length;
      const delimiters =
        mode === "markdown"
          ? getMarkdownMarkDelimiters(node)
          : { prefix: "", suffix: "" };
      if (position < end) {
        index += delimiters.prefix.length + Math.max(0, position - pos);
        found = true;
        return false;
      }
      if (position === end) {
        index += delimiters.prefix.length + text.length + delimiters.suffix.length;
        found = true;
        return false;
      }
      index += delimiters.prefix.length + text.length + delimiters.suffix.length;
      return false;
    }

    if (node.type.name === "hardBreak") {
      if (position <= pos + node.nodeSize) {
        found = true;
        return false;
      }
      index += 1;
      return false;
    }

    if (node.type.name === "mention") {
      return false;
    }

    return true;
  });

  return index;
}

function getPositionAtDraftIndex(
  editor: NonNullable<ReturnType<typeof useEditor>>,
  draftIndex: number,
  mode: TiptapReadMode,
): number {
  let index = 0;
  let position = editor.state.doc.content.size;
  let found = false;

  editor.state.doc.descendants((node, pos, parent, childIndex) => {
    if (found) {
      return false;
    }

    if (parent?.type.name === "doc") {
      if (childIndex > 0) {
        const separatorLength = mode === "markdown" ? 2 : 1;
        if (draftIndex < index + separatorLength) {
          position = pos + 1;
          found = true;
          return false;
        }
        index += separatorLength;
      }
      if (mode === "markdown" && node.type.name === "codeBlock") {
        const codeBlock = getCodeBlockMarkdownParts(node);
        if (draftIndex <= index + codeBlock.totalLength) {
          const codeContentIndex = draftIndex - index - codeBlock.prefixLength;
          if (codeContentIndex <= 0) {
            position = pos + 1;
          } else if (codeContentIndex <= codeBlock.contentLength) {
            position = pos + 1 + codeContentIndex;
          } else {
            position = pos + node.nodeSize;
          }
          found = true;
          return false;
        }
        index += codeBlock.totalLength;
        return false;
      }
    }

    if (mode === "markdown") {
      const prefixLength = getMarkdownBlockPrefixLength(node, parent, childIndex);
      if (prefixLength > 0) {
        if (draftIndex <= index + prefixLength) {
          position = pos + 1;
          found = true;
          return false;
        }
        index += prefixLength;
      }
    }

    if (node.isText) {
      const textLength = node.text?.length ?? 0;
      const delimiters =
        mode === "markdown"
          ? getMarkdownMarkDelimiters(node)
          : { prefix: "", suffix: "" };
      const totalLength =
        delimiters.prefix.length + textLength + delimiters.suffix.length;
      if (draftIndex <= index + totalLength) {
        const textIndex = draftIndex - index - delimiters.prefix.length;
        position = pos + Math.max(0, Math.min(textLength, textIndex));
        found = true;
        return false;
      }
      index += totalLength;
      return false;
    }

    if (node.type.name === "hardBreak") {
      if (draftIndex <= index + 1) {
        position = pos + node.nodeSize;
        found = true;
        return false;
      }
      index += 1;
      return false;
    }

    if (node.type.name === "mention") {
      if (draftIndex <= index) {
        position = pos + node.nodeSize;
        found = true;
        return false;
      }
      return false;
    }

    return true;
  });

  return Math.max(1, position);
}

function getSkillSummary(attrs: Record<string, unknown>): AppServerSkillSummary {
  const name = typeof attrs.name === "string" ? attrs.name : String(attrs.id ?? "skill");
  return {
    name,
    path: typeof attrs.path === "string" ? attrs.path : undefined,
    description:
      typeof attrs.description === "string" ? attrs.description : undefined,
    shortDescription:
      typeof attrs.shortDescription === "string"
        ? attrs.shortDescription
        : undefined,
  };
}

function getSkillMentionAttrs(skill: ComposerSkillToken): Record<string, unknown> {
  return {
    id: skill.id,
    name: skill.name,
    path: skill.path ?? null,
    description: skill.description ?? null,
    shortDescription: skill.shortDescription ?? null,
  };
}

function getContentSignature(params: {
  skillTokens: ComposerSkillToken[];
  value: string;
}): string {
  return JSON.stringify({
    value: params.value,
    tokens: params.skillTokens.map((token) => ({
      index: token.index,
      name: token.name,
      path: token.path,
    })),
  });
}

function closeEditorHistory(editor: TiptapEditor): void {
  editor.view.dispatch(closeHistory(editor.state.tr));
}

function applyExternalSkillInsertion(params: {
  current: TiptapReadState;
  editor: TiptapEditor;
  nextSkillTokens: ComposerSkillToken[];
  nextValue: string;
  readMode: TiptapReadMode;
  selectionIndex: number;
}): boolean {
  if (params.nextSkillTokens.length !== params.current.skillTokens.length + 1) {
    return false;
  }

  const currentTokenIds = new Set(
    params.current.skillTokens.map((token) => token.id),
  );
  const insertedSkill = params.nextSkillTokens.find(
    (token) => !currentTokenIds.has(token.id),
  );
  if (!insertedSkill) {
    return false;
  }

  const trigger =
    findSkillTrigger(params.current.value, params.selectionIndex) ??
    findSkillTrigger(params.current.value, params.current.value.length);
  if (!trigger || trigger.start !== insertedSkill.index) {
    return false;
  }

  const before = params.current.value.slice(0, trigger.start);
  const after = params.current.value.slice(trigger.end);
  const insertedSpace = after.length > 0 && !/^\s/.test(after);
  const expectedValue = `${before}${insertedSpace ? " " : ""}${after}`;
  if (params.nextValue !== expectedValue) {
    return false;
  }

  const from = getPositionAtDraftIndex(
    params.editor,
    trigger.start,
    params.readMode,
  );
  const to = getPositionAtDraftIndex(params.editor, trigger.end, params.readMode);
  const insertedContent: JSONContent[] = [
    {
      type: "mention",
      attrs: getSkillMentionAttrs(insertedSkill),
    },
  ];
  if (insertedSpace) {
    insertedContent.push({ type: "text", text: " " });
  }

  closeEditorHistory(params.editor);
  const inserted = params.editor.commands.insertContentAt(
    { from, to },
    insertedContent,
    { updateSelection: true },
  );
  if (inserted) {
    closeEditorHistory(params.editor);
  }
  return inserted;
}

export const ComposerTiptapInput = forwardRef<
  ComposerInputHandle,
  ComposerTiptapInputProps
>(function ComposerTiptapInput(props, ref) {
  const propsRef = useRef(props);
  const editorRef = useRef<TiptapEditor | null>(null);
  const selectionIndexRef = useRef(props.value.length);
  const pendingExternalSignatureRef = useRef<string | undefined>(undefined);
  const pendingSelectionIndexRef = useRef<number | undefined>(undefined);
  const appliedSelectionRequestIdRef = useRef<string | undefined>(undefined);
  const deletedSingleSkillRef = useRef<DeletedSingleSkillState | undefined>(
    undefined,
  );
  const controlledUndoStackRef = useRef<ControlledHistoryEntry[]>([]);
  const controlledRedoStackRef = useRef<ControlledHistoryEntry[]>([]);
  const applyingControlledHistoryRef = useRef(false);
  const controlledChangeInProgressRef = useRef(false);
  const readMode: TiptapReadMode = props.markdownConversion ? "markdown" : "text";
  const propsSignature = getContentSignature({
    value: props.value,
    skillTokens: props.skillTokens,
  });
  const extensions = useMemo(
    () => [
      props.markdownConversion ? MarkdownStarterKit : PlainTextStarterKit,
      SkillMention,
    ],
    [props.markdownConversion],
  );

  propsRef.current = props;
  const getControlledHistoryEntry = (
    currentEditor: TiptapEditor,
  ): ControlledHistoryEntry => ({
    ...readTiptapContent(currentEditor, readMode),
    editorDocument: currentEditor.getJSON(),
    selectionIndex: selectionIndexRef.current,
  });
  const pushControlledUndoEntry = (currentEditor: TiptapEditor): void => {
    if (applyingControlledHistoryRef.current) {
      return;
    }
    const entry = getControlledHistoryEntry(currentEditor);
    const stack = controlledUndoStackRef.current;
    const previous = stack.at(-1);
    if (
      previous &&
      getContentSignature(previous) === getContentSignature(entry)
    ) {
      return;
    }
    stack.push(entry);
    if (stack.length > 100) {
      stack.shift();
    }
  };
  const restoreControlledHistoryEntry = (
    currentEditor: TiptapEditor,
    entry: ControlledHistoryEntry,
  ): void => {
    applyingControlledHistoryRef.current = true;
    closeEditorHistory(currentEditor);
    currentEditor.commands.setContent(entry.editorDocument, { emitUpdate: false });
    closeEditorHistory(currentEditor);
    selectionIndexRef.current = entry.selectionIndex;
    flushSync(() => {
      propsRef.current.onChange(entry.value, entry.skillTokens, {
        editorDocument: entry.editorDocument,
      });
    });
    applyingControlledHistoryRef.current = false;
    requestAnimationFrame(() => {
      try {
        if (currentEditor.isDestroyed) {
          return;
        }
        currentEditor.commands.focus();
        currentEditor.commands.setTextSelection(
          getPositionAtDraftIndex(currentEditor, entry.selectionIndex, readMode),
        );
      } catch {
        // jsdom and detached editor states can fail selection mapping.
      }
    });
  };
  const applySelectionRequest = (
    currentEditor: TiptapEditor,
    request: ComposerTiptapInputProps["selectionRequest"] | undefined,
  ): void => {
    if (!request || appliedSelectionRequestIdRef.current === request.id) {
      return;
    }
    appliedSelectionRequestIdRef.current = request.id;
    selectionIndexRef.current = request.index;
    currentEditor.commands.focus();
    currentEditor.commands.setTextSelection(
      getPositionAtDraftIndex(currentEditor, request.index, readMode),
    );
  };
  const runUndoOrRedo = (
    currentEditor: TiptapEditor,
    direction: "undo" | "redo",
  ): boolean => {
    const sourceStack =
      direction === "undo"
        ? controlledUndoStackRef.current
        : controlledRedoStackRef.current;
    const targetStack =
      direction === "undo"
        ? controlledRedoStackRef.current
        : controlledUndoStackRef.current;
    const entry = sourceStack.pop();
    if (entry) {
      targetStack.push(getControlledHistoryEntry(currentEditor));
      restoreControlledHistoryEntry(currentEditor, entry);
      return true;
    }

    const beforeSignature = getContentSignature(
      readTiptapContent(currentEditor, readMode),
    );
    const handled =
      direction === "undo"
        ? currentEditor.commands.undo()
        : currentEditor.commands.redo();
    const afterSignature = getContentSignature(
      readTiptapContent(currentEditor, readMode),
    );
    if (handled && beforeSignature !== afterSignature) {
      return true;
    }

    return handled;
  };
  const initialContent = useMemo(
    () =>
      props.editorDocument ??
      buildTiptapContent(props.value, props.skillTokens, {
        markdownConversion: props.markdownConversion,
      }),
    [],
  );
  const editor = useEditor({
    content: initialContent,
    editorProps: {
      attributes: {
        // ARIA 1.2 textbox + listbox autocomplete pattern. We
        // deliberately do NOT set aria-expanded here — that attribute
        // is invalid on role="textbox" (per the spec, it belongs on
        // role="combobox"), and axe-core flags it under
        // aria-allowed-attr. The popup's open/closed state is still
        // conveyed via aria-controls being present (and pointing at
        // the visible listbox) when autocomplete is open, and absent
        // otherwise; the layout effect below mirrors that.
        // aria-controls / aria-activedescendant are only set when
        // truthy — an empty IDREF is itself an axe violation.
        ...(props.ariaActiveDescendant
          ? { "aria-activedescendant": props.ariaActiveDescendant }
          : {}),
        ...(props.ariaControls
          ? { "aria-controls": props.ariaControls }
          : {}),
        "aria-autocomplete": "list",
        "aria-label": props.label,
        class: `composer-tiptap-input__editor${props.disabled ? " is-disabled" : ""}`,
        "data-placeholder": props.placeholder,
        id: props.id,
        role: "textbox",
      },
      handleClick: (_view, _pos, event) => {
        propsRef.current.onClick?.(event as unknown as MouseEvent<HTMLDivElement>);
        return false;
      },
      handleDOMEvents: {
        dragover: (_view, event) => {
          propsRef.current.onDragOver?.(event as unknown as DragEvent<HTMLDivElement>);
          return event.defaultPrevented;
        },
        drop: (_view, event) => {
          propsRef.current.onDrop?.(event as unknown as DragEvent<HTMLDivElement>);
          return event.defaultPrevented;
        },
        keydown: (_view, event) => {
          const macPlatform = isMacPlatform();
          if (
            event.key.toLowerCase() === "y" &&
            (event.metaKey || event.ctrlKey) &&
            !event.altKey &&
            !event.shiftKey
          ) {
            const currentEditor = editorRef.current;
            if (!currentEditor) {
              return false;
            }
            event.preventDefault();
            return runUndoOrRedo(currentEditor, "redo");
          }

          if (
            event.key.toLowerCase() === "z" &&
            (event.metaKey || event.ctrlKey) &&
            !event.altKey &&
            event.shiftKey
          ) {
            const currentEditor = editorRef.current;
            if (!currentEditor) {
              return false;
            }
            event.preventDefault();
            return runUndoOrRedo(currentEditor, "redo");
          }

          if (
            event.key.toLowerCase() === "z" &&
            (event.metaKey || event.ctrlKey) &&
            !event.altKey &&
            !event.shiftKey &&
            deletedSingleSkillRef.current
          ) {
            const deleted = deletedSingleSkillRef.current;
            deletedSingleSkillRef.current = undefined;
            event.preventDefault();
            const currentEditor = editorRef.current;
            if (!currentEditor) {
              return true;
            }
            closeEditorHistory(currentEditor);
            currentEditor.commands.setContent(deleted.editorDocument, {
              emitUpdate: false,
            });
            closeEditorHistory(currentEditor);
            selectionIndexRef.current = deleted.selectionIndex;
            flushSync(() => {
              propsRef.current.onChange(deleted.value, deleted.skillTokens, {
                editorDocument: deleted.editorDocument,
              });
            });
            currentEditor.commands.setTextSelection(
              getPositionAtDraftIndex(currentEditor, deleted.selectionIndex, readMode),
            );
            return true;
          }

          if (
            event.key.toLowerCase() === "a" &&
            ((macPlatform && event.metaKey && !event.ctrlKey) ||
              (!macPlatform && event.ctrlKey && !event.metaKey)) &&
            !event.altKey &&
            !event.shiftKey
          ) {
            event.preventDefault();
            editorRef.current?.commands.selectAll();
            return true;
          }

          if (
            macPlatform &&
            event.key.toLowerCase() === "a" &&
            event.ctrlKey &&
            !event.metaKey &&
            !event.altKey &&
            !event.shiftKey
          ) {
            return true;
          }

          if (
            (event.key === "Backspace" || event.key === "Delete") &&
            propsRef.current.value.trim().length === 0 &&
            propsRef.current.skillTokens.length === 1
          ) {
            event.preventDefault();
            const currentEditor = editorRef.current;
            if (!currentEditor) {
              return true;
            }
            deletedSingleSkillRef.current = {
              editorDocument: currentEditor.getJSON(),
              selectionIndex: selectionIndexRef.current,
              skillTokens: propsRef.current.skillTokens,
              value: propsRef.current.value,
            };
            closeEditorHistory(currentEditor);
            currentEditor.commands.setContent(buildTiptapContent("", []), {
              emitUpdate: false,
            });
            closeEditorHistory(currentEditor);
            flushSync(() => {
              propsRef.current.onChange("", [], {
                editorDocument: currentEditor.getJSON(),
              });
            });
            return true;
          }

          if (
            event.key.toLowerCase() === "z" &&
            (event.metaKey || event.ctrlKey) &&
            !event.altKey &&
            !event.shiftKey
          ) {
            const currentEditor = editorRef.current;
            if (!currentEditor) {
              return false;
            }
            event.preventDefault();
            return runUndoOrRedo(currentEditor, "undo");
          }

          if (
            propsRef.current.markdownConversion &&
            event.key === "ArrowRight" &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.shiftKey
          ) {
            const currentEditor = editorRef.current;
            if (currentEditor && insertPlainSpaceAtTextblockEnd(currentEditor)) {
              event.preventDefault();
              return true;
            }
          }

          if (
            propsRef.current.markdownConversion &&
            event.key === "Enter" &&
            (event.shiftKey || event.altKey)
          ) {
            event.preventDefault();
            const currentEditor = editorRef.current;
            if (!currentEditor) {
              return false;
            }
            return event.altKey
              ? insertWysiwygSoftBreak(currentEditor)
              : insertWysiwygLineBreak(currentEditor);
          }
          propsRef.current.onKeyDown?.(event as unknown as KeyboardEvent<HTMLDivElement>);
          return event.defaultPrevented;
        },
        paste: (_view, event) => {
          propsRef.current.onPaste?.(event as unknown as ClipboardEvent<HTMLDivElement>);
          if (event.defaultPrevented) {
            return true;
          }
          const currentEditor = editorRef.current;
          if (!currentEditor || !propsRef.current.markdownConversion) {
            return false;
          }
          return pastePlainTextIntoActiveBlock(
            currentEditor,
            event as unknown as ClipboardEvent<HTMLDivElement>,
          );
        },
      },
    },
    enableInputRules: props.markdownConversion ? true : false,
    enablePasteRules: props.markdownConversion ? true : false,
    extensions,
    onUpdate: ({ editor: nextEditor }) => {
      const next = readTiptapContent(nextEditor, readMode);
      const pendingSignature = pendingExternalSignatureRef.current;
      if (
        pendingSignature &&
        getContentSignature({
          value: next.value,
          skillTokens: next.skillTokens,
        }) !== pendingSignature
      ) {
        return;
      }
      pendingExternalSignatureRef.current = undefined;
      if (
        !pendingSignature &&
        !controlledChangeInProgressRef.current &&
        !applyingControlledHistoryRef.current
      ) {
        controlledUndoStackRef.current = [];
        controlledRedoStackRef.current = [];
      }
      selectionIndexRef.current = getDraftIndexAtPosition(
        nextEditor,
        nextEditor.state.selection.from,
        readMode,
      );
      propsRef.current.onChange(next.value, next.skillTokens, {
        editorDocument: nextEditor.getJSON(),
      });
    },
    onSelectionUpdate: ({ editor: nextEditor }) => {
      selectionIndexRef.current = getDraftIndexAtPosition(
        nextEditor,
        nextEditor.state.selection.from,
        readMode,
      );
    },
  });
  editorRef.current = editor;

  useLayoutEffect(() => {
    if (!editor) {
      return;
    }

    editor.setEditable(!props.disabled);
    editor.view.dom.setAttribute("id", props.id);
    editor.view.dom.setAttribute("aria-label", props.label);
    // aria-expanded is deliberately NOT set on the textbox role — see
    // the editorProps.attributes block above for the rationale. The
    // ariaExpanded prop is still consumed via the aria-controls /
    // aria-activedescendant mirroring below, which is what conveys
    // popup state to screen readers under the ARIA 1.2 textbox +
    // autocomplete pattern.
    if (props.ariaActiveDescendant) {
      editor.view.dom.setAttribute("aria-activedescendant", props.ariaActiveDescendant);
    } else {
      editor.view.dom.removeAttribute("aria-activedescendant");
    }
    if (props.ariaControls) {
      editor.view.dom.setAttribute("aria-controls", props.ariaControls);
    } else {
      editor.view.dom.removeAttribute("aria-controls");
    }
  }, [
    editor,
    props.ariaActiveDescendant,
    props.ariaControls,
    props.ariaExpanded,
    props.disabled,
    props.id,
    props.label,
  ]);

  useLayoutEffect(() => {
    if (!editor) {
      return;
    }

    const editorDom = editor.view.dom as HTMLElement & {
      selectionEnd?: number;
      selectionStart?: number;
      setSelectionRange?: (start: number, end?: number) => void;
      value?: string;
    };
    Object.defineProperty(editorDom, "value", {
      configurable: true,
      get: () => propsRef.current.value,
      set: (nextValue) => {
        const value = String(nextValue ?? "");
        pushControlledUndoEntry(editor);
        controlledRedoStackRef.current = [];
        controlledChangeInProgressRef.current = true;
        selectionIndexRef.current = value.length;
        editor.commands.setContent(
          buildTiptapContent(value, [], {
            markdownConversion: propsRef.current.markdownConversion,
          }),
          { emitUpdate: true },
        );
        flushSync(() => {
          propsRef.current.onChange(value, [], {
            editorDocument: editor.getJSON(),
          });
        });
        controlledChangeInProgressRef.current = false;
      },
    });
    Object.defineProperty(editorDom, "selectionStart", {
      configurable: true,
      get: () => selectionIndexRef.current,
    });
    Object.defineProperty(editorDom, "selectionEnd", {
      configurable: true,
      get: () => selectionIndexRef.current,
    });
    Object.defineProperty(editorDom, "setSelectionRange", {
      configurable: true,
      value: (start: number) => {
        selectionIndexRef.current = start;
        try {
          editor.commands.setTextSelection(
            getPositionAtDraftIndex(editor, start, readMode),
          );
        } catch {
          // jsdom does not implement the layout APIs ProseMirror uses when
          // scrolling selections; the stored selection index is enough there.
        }
      },
    });

    return () => {
      delete editorDom.value;
      delete editorDom.selectionStart;
      delete editorDom.selectionEnd;
      delete editorDom.setSelectionRange;
    };
  }, [editor, readMode]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const current = readTiptapContent(editor, readMode);
    const currentSignature = getContentSignature(current);
    const currentEditorDocumentSignature = JSON.stringify(editor.getJSON());
    const nextEditorDocumentSignature = props.editorDocument
      ? JSON.stringify(props.editorDocument)
      : undefined;
    if (currentSignature === propsSignature) {
      if (
        !nextEditorDocumentSignature ||
        currentEditorDocumentSignature === nextEditorDocumentSignature
      ) {
        pendingExternalSignatureRef.current = undefined;
        return;
      }
    }

    if (
      nextEditorDocumentSignature &&
      currentEditorDocumentSignature !== nextEditorDocumentSignature
    ) {
      pendingExternalSignatureRef.current = propsSignature;
      pushControlledUndoEntry(editor);
      controlledRedoStackRef.current = [];
      closeEditorHistory(editor);
      editor.commands.setContent(props.editorDocument!, { emitUpdate: false });
      closeEditorHistory(editor);
      applySelectionRequest(editor, props.selectionRequest);
      pendingExternalSignatureRef.current = undefined;
      return;
    }

    pendingExternalSignatureRef.current = propsSignature;
    pushControlledUndoEntry(editor);
    controlledRedoStackRef.current = [];
    if (
      applyExternalSkillInsertion({
        current,
        editor,
        nextSkillTokens: props.skillTokens,
        nextValue: props.value,
        readMode,
        selectionIndex: selectionIndexRef.current,
      })
    ) {
      pendingSelectionIndexRef.current = undefined;
      return;
    }

    pendingExternalSignatureRef.current = propsSignature;
    closeEditorHistory(editor);
    editor.commands.setContent(
      buildTiptapContent(props.value, props.skillTokens, {
        markdownConversion: props.markdownConversion,
      }),
      { emitUpdate: false },
    );
    closeEditorHistory(editor);
    pendingExternalSignatureRef.current = undefined;

    if (pendingSelectionIndexRef.current !== undefined) {
      const nextSelectionIndex = pendingSelectionIndexRef.current;
      pendingSelectionIndexRef.current = undefined;
      selectionIndexRef.current = nextSelectionIndex;
      editor.commands.setTextSelection(
        getPositionAtDraftIndex(editor, nextSelectionIndex, readMode),
      );
    } else {
      applySelectionRequest(editor, props.selectionRequest);
    }
  }, [
    editor,
    props.editorDocument,
    props.selectionRequest,
    props.skillTokens,
    props.value,
    propsSignature,
    readMode,
  ]);

  useLayoutEffect(() => {
    if (
      !editor ||
      !props.selectionRequest ||
      appliedSelectionRequestIdRef.current === props.selectionRequest.id
    ) {
      return;
    }

    appliedSelectionRequestIdRef.current = props.selectionRequest.id;
    selectionIndexRef.current = props.selectionRequest.index;
    editor.commands.focus();
    editor.commands.setTextSelection(
      getPositionAtDraftIndex(editor, props.selectionRequest.index, readMode),
    );
  }, [editor, props.selectionRequest, readMode]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    editor.view.dom
      .querySelectorAll<HTMLElement>(".composer-tiptap-input__mention")
      .forEach((node) => {
        const attrs = Object.fromEntries(
          Array.from(node.attributes).map((attribute) => [
            attribute.name,
            attribute.value,
          ]),
        );
        const tooltip = buildSkillTooltip(
          getSkillSummary({
            name: node.textContent?.replace(/^\$/, ""),
            path: attrs["data-skill-path"],
          }),
        );
        if (tooltip) {
          node.setAttribute("data-tooltip", tooltip);
        }
      });
  }, [editor, props.skillTokens]);

  useImperativeHandle(ref, () => ({
    deleteSelection: () => {
      editor?.commands.deleteSelection();
    },
    focus: () => {
      if (
        editor &&
        getContentSignature(readTiptapContent(editor, readMode)) !== propsSignature
      ) {
        pendingExternalSignatureRef.current = propsSignature;
      }
      editor?.commands.focus();
    },
    get selectionEnd() {
      return selectionIndexRef.current;
    },
    get selectionStart() {
      return selectionIndexRef.current;
    },
    get skillTokenCount() {
      return editor
        ? readTiptapContent(editor, readMode).skillTokens.length
        : props.skillTokens.length;
    },
    get value() {
      return editor ? readTiptapContent(editor, readMode).value : props.value;
    },
    setSelectionRange: (start: number) => {
      if (!editor) {
        return;
      }
      const current = readTiptapContent(editor, readMode);
      if (getContentSignature(current) !== propsSignature) {
        pendingExternalSignatureRef.current = propsSignature;
        pendingSelectionIndexRef.current = start;
        selectionIndexRef.current = start;
        return;
      }
      selectionIndexRef.current = start;
      editor.commands.setTextSelection(getPositionAtDraftIndex(editor, start, readMode));
    },
  }));

  return (
    <div
      className={`composer-tiptap-input${props.value || props.skillTokens.length > 0 ? "" : " is-empty"}`}
      data-placeholder={props.placeholder}
      data-testid="composer-tiptap-input"
      data-value={props.value}
      onKeyDownCapture={(event) => {
        if (!editor || event.defaultPrevented) {
          return;
        }
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          propsRef.current.onKeyDown?.(event as unknown as KeyboardEvent<HTMLDivElement>);
          if (event.defaultPrevented) {
            event.stopPropagation();
          }
          return;
        }
        if (
          event.key.toLowerCase() === "z" &&
          (event.metaKey || event.ctrlKey) &&
          !event.altKey &&
          !event.shiftKey &&
          deletedSingleSkillRef.current
        ) {
          return;
        }
        if (
          event.key.toLowerCase() === "y" &&
          (event.metaKey || event.ctrlKey) &&
          !event.altKey &&
          !event.shiftKey
        ) {
          event.preventDefault();
          event.stopPropagation();
          runUndoOrRedo(editor, "redo");
          return;
        }
        if (
          event.key.toLowerCase() === "z" &&
          (event.metaKey || event.ctrlKey) &&
          !event.altKey
        ) {
          event.preventDefault();
          event.stopPropagation();
          runUndoOrRedo(editor, event.shiftKey ? "redo" : "undo");
        }
      }}
    >
      <EditorContent editor={editor} />
    </div>
  );
});
