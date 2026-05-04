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
import Mention from "@tiptap/extension-mention";
import StarterKit from "@tiptap/starter-kit";
import { EditorContent, useEditor, type JSONContent } from "@tiptap/react";
import type { AppServerSkillSummary } from "@pwragent/shared";
import { buildSkillTooltip, findSkillTrigger } from "../../lib/skill-mentions";
import type {
  ComposerRichInputHandle,
  ComposerRichInputProps,
  ComposerSkillToken,
} from "./ComposerRichInput";

type ComposerTiptapInputProps = ComposerRichInputProps & {
  editorDocument?: JSONContent;
  markdownConversion?: boolean;
};

type TiptapReadMode = "markdown" | "text";

type TiptapReadState = {
  skillTokens: ComposerSkillToken[];
  value: string;
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
    class: "thread-row__chip skill-chip composer-tiptap-input__mention",
  },
  renderHTML: ({ node }) => {
    const skill = getSkillSummary(node.attrs);
    const tooltip = buildSkillTooltip(skill);
    return [
      "span",
      {
        class: "thread-row__chip skill-chip composer-tiptap-input__mention",
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

function buildTiptapContent(
  value: string,
  skillTokens: ComposerSkillToken[],
): JSONContent {
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
      return true;
    }

    if (node.isText) {
      const text = node.text ?? "";
      const end = pos + text.length;
      if (position <= end) {
        index += Math.max(0, Math.min(text.length, position - pos));
        found = true;
        return false;
      }
      index += text.length;
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
      return true;
    }

    if (node.isText) {
      const textLength = node.text?.length ?? 0;
      if (draftIndex <= index + textLength) {
        position = pos + Math.max(0, draftIndex - index);
        found = true;
        return false;
      }
      index += textLength;
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

  return params.editor.commands.insertContentAt(
    { from, to },
    insertedContent,
    { updateSelection: true },
  );
}

export const ComposerTiptapInput = forwardRef<
  ComposerRichInputHandle,
  ComposerTiptapInputProps
>(function ComposerTiptapInput(props, ref) {
  const propsRef = useRef(props);
  const editorRef = useRef<TiptapEditor | null>(null);
  const selectionIndexRef = useRef(props.value.length);
  const pendingExternalSignatureRef = useRef<string | undefined>(undefined);
  const pendingSelectionIndexRef = useRef<number | undefined>(undefined);
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
  const initialContent = useMemo(
    () => props.editorDocument ?? buildTiptapContent(props.value, props.skillTokens),
    []
  );
  const editor = useEditor({
    content: initialContent,
    editorProps: {
      attributes: {
        "aria-activedescendant": props.ariaActiveDescendant ?? "",
        "aria-controls": props.ariaControls ?? "",
        "aria-expanded": String(Boolean(props.ariaExpanded)),
        "aria-label": props.label,
        class: `composer-tiptap-input__editor${props.disabled ? " is-disabled" : ""}`,
        "data-placeholder": props.placeholder,
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
          const currentProps = propsRef.current;
          if (
            (event.key === "Backspace" || event.key === "Delete") &&
            currentProps.value.trim().length === 0 &&
            currentProps.skillTokens.length === 1
          ) {
            event.preventDefault();
            const currentEditor = editorRef.current;
            currentEditor?.commands.setContent(buildTiptapContent("", []), {
              emitUpdate: false,
            });
            propsRef.current.onChange("", []);
            return true;
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
          return event.defaultPrevented;
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
    editor.view.dom.setAttribute("aria-label", props.label);
    editor.view.dom.setAttribute("aria-expanded", String(Boolean(props.ariaExpanded)));
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
    props.label,
  ]);

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
      editor.commands.setContent(props.editorDocument!, { emitUpdate: false });
      pendingExternalSignatureRef.current = undefined;
      return;
    }

    pendingExternalSignatureRef.current = propsSignature;
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
    editor.commands.setContent(
      buildTiptapContent(props.value, props.skillTokens),
      { emitUpdate: false },
    );
    pendingExternalSignatureRef.current = undefined;

    if (pendingSelectionIndexRef.current !== undefined) {
      const nextSelectionIndex = pendingSelectionIndexRef.current;
      pendingSelectionIndexRef.current = undefined;
      selectionIndexRef.current = nextSelectionIndex;
      editor.commands.setTextSelection(
        getPositionAtDraftIndex(editor, nextSelectionIndex, readMode),
      );
    }
  }, [
    editor,
    props.editorDocument,
    props.skillTokens,
    props.value,
    propsSignature,
    readMode,
  ]);

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
    >
      <EditorContent editor={editor} />
    </div>
  );
});
