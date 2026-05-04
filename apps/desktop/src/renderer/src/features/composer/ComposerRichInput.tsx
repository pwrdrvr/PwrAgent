import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import type { AppServerSkillSummary } from "@pwragent/shared";
import { SkillChip } from "./SkillChip";

export type ComposerSkillToken = AppServerSkillSummary & {
  id: string;
  index: number;
};

export type ComposerRichInputHandle = {
  deleteSelection: (direction: "backward" | "forward") => void;
  focus: () => void;
  readonly selectionEnd: number;
  readonly selectionStart: number;
  setSelectionRange: (start: number, end: number) => void;
};

export type ComposerRichInputProps = {
  ariaActiveDescendant?: string;
  ariaControls?: string;
  ariaExpanded?: boolean;
  disabled?: boolean;
  id: string;
  label: string;
  onChange: (value: string, skillTokens?: ComposerSkillToken[]) => void;
  onBeforeInput?: (event: FormEvent<HTMLDivElement>) => void;
  onBeforeInputCapture?: (event: FormEvent<HTMLDivElement>) => void;
  onClick?: (event: MouseEvent<HTMLDivElement>) => void;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onKeyDownCapture?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
  placeholder: string;
  skillTokens: ComposerSkillToken[];
  value: string;
};

type InlinePart =
  | {
      key: string;
      text: string;
      type: "text";
    }
  | {
      key: string;
      skill: ComposerSkillToken;
      type: "skill";
    };

function buildInlineParts(
  value: string,
  skillTokens: ComposerSkillToken[],
): InlinePart[] {
  const sortedTokens = [...skillTokens].sort((left, right) => {
    if (left.index !== right.index) {
      return left.index - right.index;
    }
    return left.id.localeCompare(right.id);
  });

  const parts: InlinePart[] = [];
  let cursor = 0;
  sortedTokens.forEach((skill, tokenIndex) => {
    const index = Math.max(0, Math.min(skill.index, value.length));
    if (index > cursor) {
      parts.push({
        key: `text:${cursor}:${index}:${value.slice(cursor, index)}`,
        text: value.slice(cursor, index),
        type: "text",
      });
    }
    parts.push({
      key: `skill:${skill.id}:${tokenIndex}`,
      skill,
      type: "skill",
    });
    cursor = index;
  });

  if (cursor < value.length) {
    parts.push({
      key: `text:${cursor}:end:${value.slice(cursor)}`,
      text: value.slice(cursor),
      type: "text",
    });
  }

  return parts;
}

function isSkillTokenElement(node: Node): boolean {
  return (
    node.nodeType === Node.ELEMENT_NODE &&
    (node as Element).hasAttribute("data-composer-skill-token-id")
  );
}

function walkEditorContent(params: {
  knownTokens: Map<string, ComposerSkillToken>;
  node: Node;
  onText: (text: string) => void;
  onToken: (token: ComposerSkillToken) => void;
}): void {
  const { knownTokens, node, onText, onToken } = params;
  if (node.nodeType === Node.TEXT_NODE) {
    onText(node.nodeValue ?? "");
    return;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    Array.from(node.childNodes).forEach((child) =>
      walkEditorContent({ knownTokens, node: child, onText, onToken })
    );
    return;
  }

  const element = node as Element;

  if (isSkillTokenElement(element)) {
    const tokenId = (element as HTMLElement).dataset.composerSkillTokenId;
    const token = tokenId ? knownTokens.get(tokenId) : undefined;
    if (token) {
      onToken(token);
    }
    return;
  }

  if (element.nodeName === "BR") {
    onText("\n");
    return;
  }

  Array.from(element.childNodes).forEach((child) =>
    walkEditorContent({ knownTokens, node: child, onText, onToken })
  );
}

function readEditorContent(
  editor: HTMLElement,
  knownTokens: Map<string, ComposerSkillToken>,
): {
  skillTokens: ComposerSkillToken[];
  value: string;
} {
  let value = "";
  const skillTokens: ComposerSkillToken[] = [];

  editor.childNodes.forEach((node) =>
    walkEditorContent({
      knownTokens,
      node,
      onText: (text) => {
        value += text;
      },
      onToken: (token) => {
        skillTokens.push({
          ...token,
          index: value.length,
        });
      },
    })
  );

  return { value, skillTokens };
}

function getNodeStartIndex(
  editor: HTMLElement,
  targetNode: Node,
  knownTokens: Map<string, ComposerSkillToken>,
): number {
  let index = 0;
  let found = false;

  const visit = (node: Node): void => {
    if (found) {
      return;
    }
    if (node === targetNode) {
      found = true;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      index += node.nodeValue?.length ?? 0;
      return;
    }
    if (isSkillTokenElement(node)) {
      return;
    }
    if (node instanceof HTMLElement && node.tagName === "BR") {
      index += 1;
      return;
    }
    node.childNodes.forEach(visit);
  };

  editor.childNodes.forEach((node) => {
    if (!found) {
      visit(node);
    }
  });

  // Keep the token map in the signature so this mirrors the content walker;
  // token nodes are intentionally zero-width in the composer draft.
  void knownTokens;
  return index;
}

function getSelectionIndex(
  editor: HTMLElement | null,
  knownTokens: Map<string, ComposerSkillToken>,
): number {
  if (!editor) {
    return 0;
  }

  const selection = editor.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return readEditorContent(editor, knownTokens).value.length;
  }

  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer)) {
    return readEditorContent(editor, knownTokens).value.length;
  }

  if (range.startContainer.nodeType === Node.TEXT_NODE) {
    return (
      getNodeStartIndex(editor, range.startContainer, knownTokens) +
      range.startOffset
    );
  }

  const container = range.startContainer;
  let index = getNodeStartIndex(editor, container, knownTokens);
  const childNodes = Array.from(container.childNodes).slice(0, range.startOffset);
  childNodes.forEach((node) => {
    walkEditorContent({
      knownTokens,
      node,
      onText: (text) => {
        index += text.length;
      },
      onToken: () => undefined,
    });
  });

  return index;
}

function getBoundaryIndex(
  editor: HTMLElement,
  container: Node,
  offset: number,
  knownTokens: Map<string, ComposerSkillToken>,
): number {
  if (container.nodeType === Node.TEXT_NODE) {
    return getNodeStartIndex(editor, container, knownTokens) + offset;
  }

  let index = getNodeStartIndex(editor, container, knownTokens);
  const childNodes = Array.from(container.childNodes).slice(0, offset);
  childNodes.forEach((node) => {
    walkEditorContent({
      knownTokens,
      node,
      onText: (text) => {
        index += text.length;
      },
      onToken: () => undefined,
    });
  });

  return index;
}

function getSelectionIndexes(
  editor: HTMLElement,
  knownTokens: Map<string, ComposerSkillToken>,
): {
  end: number;
  start: number;
} {
  const fallback = readEditorContent(editor, knownTokens).value.length;
  const selection = editor.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return { start: fallback, end: fallback };
  }

  const range = selection.getRangeAt(0);
  const containsStart = editor.contains(range.startContainer);
  const containsEnd = editor.contains(range.endContainer);
  if (!containsStart && !containsEnd) {
    if (range.intersectsNode(editor)) {
      return { start: 0, end: fallback };
    }
    return { start: fallback, end: fallback };
  }

  const start = containsStart
    ? getBoundaryIndex(
        editor,
        range.startContainer,
        range.startOffset,
        knownTokens,
      )
    : 0;
  const end = containsEnd
    ? getBoundaryIndex(
        editor,
        range.endContainer,
        range.endOffset,
        knownTokens,
      )
    : fallback;

  return {
    start: Math.min(start, end),
    end: Math.max(start, end),
  };
}

function getSelectedTokenIds(editor: HTMLElement): Set<string> {
  const selection = editor.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return new Set();
  }

  const range = selection.getRangeAt(0);
  return new Set(
    Array.from(
      editor.querySelectorAll<HTMLElement>("[data-composer-skill-token-id]"),
    )
      .filter((candidate) => range.intersectsNode(candidate))
      .map((candidate) => candidate.dataset.composerSkillTokenId)
      .filter((tokenId): tokenId is string => Boolean(tokenId)),
  );
}

function setSelectionIndex(
  editor: HTMLElement | null,
  knownTokens: Map<string, ComposerSkillToken>,
  requestedIndex: number,
): void {
  if (!editor) {
    return;
  }

  const index = Math.max(0, requestedIndex);
  const document = editor.ownerDocument;
  const range = document.createRange();
  let cursor = 0;
  let placed = false;

  const placeAfter = (node: Node): void => {
    range.setStartAfter(node);
    range.collapse(true);
    placed = true;
  };

  const visit = (node: Node): void => {
    if (placed) {
      return;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.nodeValue?.length ?? 0;
      if (index < cursor + length) {
        range.setStart(node, Math.max(0, index - cursor));
        range.collapse(true);
        placed = true;
        return;
      }
      cursor += length;
      return;
    }

    if (isSkillTokenElement(node)) {
      if (index <= cursor) {
        placeAfter(node);
      }
      return;
    }

    if (node instanceof HTMLElement && node.tagName === "BR") {
      if (index <= cursor + 1) {
        placeAfter(node);
        return;
      }
      cursor += 1;
      return;
    }

    node.childNodes.forEach(visit);
  };

  editor.childNodes.forEach(visit);

  if (!placed) {
    range.selectNodeContents(editor);
    range.collapse(false);
  }

  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  void knownTokens;
}

function selectEditorContents(editor: HTMLElement): void {
  const range = editor.ownerDocument.createRange();
  range.selectNodeContents(editor);
  const selection = editor.ownerDocument.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function clampTokenIndex(index: number, value: string): number {
  return Math.max(0, Math.min(index, value.length));
}

function adjustTokensForReplacement(params: {
  end: number;
  nextValue: string;
  replacementLength: number;
  skillTokens: ComposerSkillToken[];
  start: number;
}): ComposerSkillToken[] {
  const removedLength = params.end - params.start;
  const delta = params.replacementLength - removedLength;
  const insertedEnd = params.start + params.replacementLength;

  return params.skillTokens.map((token) => {
    if (token.index <= params.start) {
      return token;
    }

    if (token.index >= params.end) {
      return {
        ...token,
        index: clampTokenIndex(token.index + delta, params.nextValue),
      };
    }

    return {
      ...token,
      index: clampTokenIndex(insertedEnd, params.nextValue),
    };
  });
}

function getSkillTokenSignature(skillTokens: ComposerSkillToken[]): string {
  return skillTokens
    .map((token) => `${token.id}:${token.index}:${token.name}:${token.path ?? ""}`)
    .join("|");
}

function isMacPlatform(): boolean {
  return /\bMac/.test(window.navigator.platform);
}

function isSelectAllShortcut(event: KeyboardEvent<HTMLDivElement>): boolean {
  if (event.altKey || event.shiftKey || event.key.toLowerCase() !== "a") {
    return false;
  }

  return isMacPlatform()
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

export const ComposerRichInput = forwardRef<
  ComposerRichInputHandle,
  ComposerRichInputProps
>(function ComposerRichInput(props, ref) {
  const editorRef = useRef<HTMLDivElement>(null);
  const knownTokensRef = useRef(new Map<string, ComposerSkillToken>());
  const onChangeRef = useRef(props.onChange);
  const pendingAssignedValueRef = useRef<string | undefined>(undefined);
  const pendingSelectionIndexRef = useRef<number | undefined>(undefined);
  const handledKeyInputRef = useRef<string | undefined>(undefined);
  const localEditValueRef = useRef<string | undefined>(undefined);
  const selectAllPendingRef = useRef(false);
  const valueRef = useRef(props.value);
  const skillTokensRef = useRef(props.skillTokens);
  const parts = useMemo(
    () => buildInlineParts(props.value, props.skillTokens),
    [props.skillTokens, props.value]
  );

  useEffect(() => {
    onChangeRef.current = props.onChange;
  }, [props.onChange]);

  useLayoutEffect(() => {
    for (const token of props.skillTokens) {
      knownTokensRef.current.set(token.id, token);
    }
  }, [props.skillTokens]);

  useLayoutEffect(() => {
    const localEditValue = localEditValueRef.current;
    const propsTokenSignature = getSkillTokenSignature(props.skillTokens);
    const currentTokenSignature = getSkillTokenSignature(skillTokensRef.current);
    if (
      localEditValue !== undefined &&
      props.value !== localEditValue &&
      propsTokenSignature === currentTokenSignature
    ) {
      return;
    }

    if (
      props.value === localEditValue ||
      propsTokenSignature !== currentTokenSignature
    ) {
      localEditValueRef.current = undefined;
    }

    valueRef.current = props.value;
    skillTokensRef.current = props.skillTokens;
  }, [props.skillTokens, props.value]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    Object.defineProperties(editor, {
      selectionEnd: {
        configurable: true,
        get: () =>
          pendingSelectionIndexRef.current ??
          getSelectionIndex(editor, knownTokensRef.current),
      },
      selectionStart: {
        configurable: true,
        get: () =>
          pendingSelectionIndexRef.current ??
          getSelectionIndex(editor, knownTokensRef.current),
      },
      setSelectionRange: {
        configurable: true,
        value: (start: number) => {
          pendingSelectionIndexRef.current = start;
          setSelectionIndex(editor, knownTokensRef.current, start);
        },
      },
      value: {
        configurable: true,
        get: () => readEditorContent(editor, knownTokensRef.current).value,
        set: (nextValue: string) => {
          pendingAssignedValueRef.current = nextValue;
        },
      },
    });
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    const handleNativeChange = (): void => {
      const assignedValue = pendingAssignedValueRef.current;
      if (assignedValue !== undefined) {
        pendingAssignedValueRef.current = undefined;
        pendingSelectionIndexRef.current = assignedValue.length;
        valueRef.current = assignedValue;
        skillTokensRef.current = [];
        onChangeRef.current(assignedValue, []);
        return;
      }

      const nextSelection = getSelectionIndex(editor, knownTokensRef.current);
      const next = readEditorContent(editor, knownTokensRef.current);
      pendingSelectionIndexRef.current = nextSelection;
      valueRef.current = next.value;
      skillTokensRef.current = next.skillTokens;
      onChangeRef.current(next.value, next.skillTokens);
    };

    editor.addEventListener("change", handleNativeChange);
    return () => {
      editor.removeEventListener("change", handleNativeChange);
    };
  }, []);

  useLayoutEffect(() => {
    const nextSelection = pendingSelectionIndexRef.current;
    if (nextSelection === undefined) {
      return;
    }

    pendingSelectionIndexRef.current = undefined;
    setSelectionIndex(editorRef.current, knownTokensRef.current, nextSelection);
  }, [parts]);

  const handleInput = (event: FormEvent<HTMLDivElement>): void => {
    const nextSelection = getSelectionIndex(
      event.currentTarget,
      knownTokensRef.current,
    );
    const next = readEditorContent(event.currentTarget, knownTokensRef.current);
    selectAllPendingRef.current = false;
    pendingSelectionIndexRef.current = nextSelection;
    valueRef.current = next.value;
    skillTokensRef.current = next.skillTokens;
    localEditValueRef.current = next.value;
    onChangeRef.current(next.value, next.skillTokens);
  };

  const replaceSelection = (
    editor: HTMLElement,
    replacement: string,
    selection?: { end: number; start: number },
    selectedTokenIds = new Set<string>(),
  ): void => {
    const currentSelection =
      selection ??
      (pendingSelectionIndexRef.current !== undefined
        ? {
            start: pendingSelectionIndexRef.current,
            end: pendingSelectionIndexRef.current,
          }
        : getSelectionIndexes(editor, knownTokensRef.current));
    const currentValue = valueRef.current;
    const currentSkillTokens = skillTokensRef.current;
    const nextValue = `${currentValue.slice(0, currentSelection.start)}${replacement}${currentValue.slice(currentSelection.end)}`;
    const nextSelection = currentSelection.start + replacement.length;
    const nextSkillTokens = adjustTokensForReplacement({
      end: currentSelection.end,
      nextValue,
      replacementLength: replacement.length,
      skillTokens: currentSkillTokens.filter(
        (token) => !selectedTokenIds.has(token.id),
      ),
      start: currentSelection.start,
    });
    pendingSelectionIndexRef.current = nextSelection;
    valueRef.current = nextValue;
    skillTokensRef.current = nextSkillTokens;
    localEditValueRef.current = nextValue;
    onChangeRef.current(nextValue, nextSkillTokens);
  };

  const deleteSelection = (
    editor: HTMLElement,
    direction: "backward" | "forward",
  ): void => {
    const selection = selectAllPendingRef.current
      ? { start: 0, end: valueRef.current.length }
      : getSelectionIndexes(editor, knownTokensRef.current);
    const selectedTokenIds = selectAllPendingRef.current
      ? new Set(skillTokensRef.current.map((token) => token.id))
      : getSelectedTokenIds(editor);
    selectAllPendingRef.current = false;
    if (selection.start !== selection.end || selectedTokenIds.size > 0) {
      replaceSelection(editor, "", selection, selectedTokenIds);
      return;
    }

    const start =
      direction === "backward" ? Math.max(0, selection.start - 1) : selection.start;
    const end =
      direction === "backward"
        ? selection.end
        : Math.min(valueRef.current.length, selection.end + 1);
    replaceSelection(editor, "", { start, end });
  };

  useImperativeHandle(ref, () => ({
    deleteSelection: (direction) => {
      const editor = editorRef.current;
      if (editor) {
        deleteSelection(editor, direction);
      }
    },
    focus: () => {
      editorRef.current?.focus();
    },
    get selectionEnd() {
      return (
        pendingSelectionIndexRef.current ??
        getSelectionIndex(editorRef.current, knownTokensRef.current)
      );
    },
    get selectionStart() {
      return (
        pendingSelectionIndexRef.current ??
        getSelectionIndex(editorRef.current, knownTokensRef.current)
      );
    },
    setSelectionRange: (start: number) => {
      pendingSelectionIndexRef.current = start;
      setSelectionIndex(editorRef.current, knownTokensRef.current, start);
    },
  }));

  const handleBeforeInputCapture = (event: FormEvent<HTMLDivElement>): void => {
    props.onBeforeInputCapture?.(event);
    if (event.defaultPrevented || props.disabled) {
      return;
    }

    const inputEvent = event.nativeEvent as InputEvent;
    if (inputEvent.inputType === "insertText") {
      event.preventDefault();
      if (
        handledKeyInputRef.current !== undefined &&
        handledKeyInputRef.current === (inputEvent.data ?? "")
      ) {
        handledKeyInputRef.current = undefined;
        return;
      }
      replaceSelection(event.currentTarget, inputEvent.data ?? "");
      return;
    }

    if (
      inputEvent.inputType === "insertLineBreak" ||
      inputEvent.inputType === "insertParagraph"
    ) {
      event.preventDefault();
      replaceSelection(event.currentTarget, "\n");
      return;
    }

    if (inputEvent.inputType === "deleteContentBackward") {
      event.preventDefault();
      deleteSelection(event.currentTarget, "backward");
      return;
    }

    if (inputEvent.inputType === "deleteContentForward") {
      event.preventDefault();
      deleteSelection(event.currentTarget, "forward");
    }
  };

  const handleKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>): void => {
    props.onKeyDownCapture?.(event);
    if (
      !event.defaultPrevented &&
      !props.disabled &&
      isSelectAllShortcut(event)
    ) {
      event.preventDefault();
      selectAllPendingRef.current = true;
      pendingSelectionIndexRef.current = undefined;
      selectEditorContents(event.currentTarget);
      return;
    }

    if (
      event.defaultPrevented ||
      props.disabled ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.key.length !== 1
    ) {
      return;
    }

    event.preventDefault();
    handledKeyInputRef.current = event.key;
    window.setTimeout(() => {
      if (handledKeyInputRef.current === event.key) {
        handledKeyInputRef.current = undefined;
      }
    }, 0);
    replaceSelection(event.currentTarget, event.key);
  };

  const handleClick = (event: MouseEvent<HTMLDivElement>): void => {
    pendingSelectionIndexRef.current = undefined;
    props.onClick?.(event);
  };

  return (
    <div
      ref={editorRef}
      id={props.id}
      aria-label={props.label}
      aria-activedescendant={props.ariaActiveDescendant}
      aria-controls={props.ariaControls}
      aria-expanded={props.ariaExpanded}
      aria-multiline="true"
      className={`composer-rich-input${props.disabled ? " is-disabled" : ""}${props.value || props.skillTokens.length > 0 ? "" : " is-empty"}`}
      contentEditable={!props.disabled}
      data-placeholder={props.placeholder}
      data-testid="composer-rich-input"
      data-value={props.value}
      role="textbox"
      suppressContentEditableWarning
      tabIndex={props.disabled ? -1 : 0}
      onClick={handleClick}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
      onChange={handleInput}
      onBeforeInputCapture={handleBeforeInputCapture}
      onBeforeInput={props.onBeforeInput}
      onInput={handleInput}
      onKeyDownCapture={handleKeyDownCapture}
      onKeyDown={props.onKeyDown}
      onPaste={props.onPaste}
    >
      {parts.map((part) =>
        part.type === "text" ? (
          <span key={part.key}>{part.text}</span>
        ) : (
          <span
            key={part.key}
            className="composer-rich-input__token"
            contentEditable={false}
            data-composer-skill-token-id={part.skill.id}
            suppressContentEditableWarning
          >
            <SkillChip label={`$${part.skill.name}`} skill={part.skill} />
          </span>
        )
      )}
    </div>
  );
});
