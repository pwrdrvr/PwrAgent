import type { ReactionEmojiCatalog } from "../navigation/reaction-emoji-catalog";
import { replaceEmojiShortcodesInText } from "../../lib/emoji-shortcodes";

type MdastNode = {
  type: string;
  value?: string;
  children?: MdastNode[];
};

export type RemarkEmojiShortcodesOptions = {
  catalog?: ReactionEmojiCatalog;
  onMissingCatalog?: () => void;
};

const SKIPPED_PARENT_TYPES = new Set([
  "code",
  "definition",
  "html",
  "image",
  "imageReference",
  "inlineCode",
  "inlineMath",
  "link",
  "linkReference",
  "math",
]);

const INLINE_FORMATTING_TYPES = new Set([
  "delete",
  "emphasis",
  "strong",
]);

const TRAILING_PUNCTUATION_PATTERN = /^[.,!?;)]/;

function isEmptyTextNode(node: MdastNode): boolean {
  return node.type === "text" && (typeof node.value !== "string" || node.value.length === 0);
}

function firstTextChar(
  node: MdastNode,
  cache: WeakMap<MdastNode, string | null>,
): string | undefined {
  const cached = cache.get(node);
  if (cached !== undefined) {
    return cached ?? undefined;
  }
  let result: string | null = null;
  if (node.type === "text" && typeof node.value === "string" && node.value.length > 0) {
    result = node.value[0]!;
  } else if (INLINE_FORMATTING_TYPES.has(node.type) && node.children) {
    for (const child of node.children) {
      const char = firstTextChar(child, cache);
      if (char !== undefined) {
        result = char;
        break;
      }
    }
  }
  cache.set(node, result);
  return result ?? undefined;
}

function lastTextEdge(
  node: MdastNode,
  cache: WeakMap<MdastNode, string | null>,
): string | undefined {
  const cached = cache.get(node);
  if (cached !== undefined) {
    return cached ?? undefined;
  }
  let result: string | null = null;
  if (node.type === "text" && typeof node.value === "string" && node.value.length > 0) {
    result = node.value.length >= 2 ? node.value.slice(-2) : node.value;
  } else if (INLINE_FORMATTING_TYPES.has(node.type) && node.children) {
    let collected = "";
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index]!;
      if (isEmptyTextNode(child)) {
        continue;
      }
      const edge = lastTextEdge(child, cache);
      if (edge === undefined) {
        if (collected.length > 0) {
          collected = `x${collected}`;
        }
        break;
      }
      collected = edge + collected;
      if (collected.length >= 2) {
        collected = collected.slice(-2);
        break;
      }
    }
    result = collected.length > 0 ? collected : null;
  }
  cache.set(node, result);
  return result ?? undefined;
}

function allowsLeadingFromSiblings(
  children: readonly MdastNode[],
  index: number,
  fallback: boolean,
  lastEdgeCache: WeakMap<MdastNode, string | null>,
): boolean {
  let prevIndex = index - 1;
  while (prevIndex >= 0 && isEmptyTextNode(children[prevIndex]!)) {
    prevIndex -= 1;
  }
  if (prevIndex < 0) {
    return fallback;
  }
  const sibling = children[prevIndex]!;
  if (sibling.type === "break") {
    return true;
  }
  const edge = lastTextEdge(sibling, lastEdgeCache);
  if (edge === undefined) {
    return false;
  }
  const last = edge[edge.length - 1]!;
  if (/\s/.test(last)) {
    return true;
  }
  if (last === "(") {
    if (edge.length >= 2) {
      return /\s/.test(edge[edge.length - 2]!);
    }
    return allowsLeadingFromSiblings(children, prevIndex, fallback, lastEdgeCache);
  }
  return false;
}

function allowsTrailingToSiblings(
  children: readonly MdastNode[],
  index: number,
  fallback: boolean,
  firstCharCache: WeakMap<MdastNode, string | null>,
): boolean {
  let nextIndex = index + 1;
  while (nextIndex < children.length && isEmptyTextNode(children[nextIndex]!)) {
    nextIndex += 1;
  }
  if (nextIndex >= children.length) {
    return fallback;
  }
  const sibling = children[nextIndex]!;
  if (sibling.type === "break") {
    return true;
  }
  const leading = firstTextChar(sibling, firstCharCache);
  return leading !== undefined && (/\s/.test(leading) || TRAILING_PUNCTUATION_PATTERN.test(leading));
}

function transformNode(
  node: MdastNode,
  catalog: ReactionEmojiCatalog | undefined,
  onMissingCatalog: (() => void) | undefined,
  parentAllowsLeading: boolean,
  parentAllowsTrailing: boolean,
  firstCharCache: WeakMap<MdastNode, string | null>,
  lastEdgeCache: WeakMap<MdastNode, string | null>,
): void {
  if (!node.children || SKIPPED_PARENT_TYPES.has(node.type)) {
    return;
  }

  const isInlineWrapper = INLINE_FORMATTING_TYPES.has(node.type);
  const baseLeading = isInlineWrapper ? parentAllowsLeading : true;
  const baseTrailing = isInlineWrapper ? parentAllowsTrailing : true;

  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index]!;
    const allowLeadingStart = allowsLeadingFromSiblings(
      node.children,
      index,
      baseLeading,
      lastEdgeCache,
    );
    const allowTrailingEnd = allowsTrailingToSiblings(
      node.children,
      index,
      baseTrailing,
      firstCharCache,
    );

    if (child.type === "text" && typeof child.value === "string") {
      child.value = replaceEmojiShortcodesInText(child.value, {
        catalog,
        allowLeadingStart,
        allowTrailingEnd,
        onMissingCatalog,
      });
      continue;
    }

    transformNode(
      child,
      catalog,
      onMissingCatalog,
      allowLeadingStart,
      allowTrailingEnd,
      firstCharCache,
      lastEdgeCache,
    );
  }
}

function resolveOptions(
  input?: ReactionEmojiCatalog | RemarkEmojiShortcodesOptions,
): RemarkEmojiShortcodesOptions {
  if (!input) {
    return {};
  }
  if ("all" in input && "byShortcode" in input) {
    return { catalog: input };
  }
  return input;
}

/**
 * Block-local Remark plugin that expands boundary-safe `:shortcode:` tokens in
 * prose text nodes while leaving code blocks, inline code, links/URLs, math,
 * and technical identifiers (`std::vector`, `foo:bar:baz`, `12:30:00`) intact.
 */
export function remarkEmojiShortcodes(
  input?: ReactionEmojiCatalog | RemarkEmojiShortcodesOptions,
) {
  const { catalog, onMissingCatalog } = resolveOptions(input);
  return (tree: MdastNode): void => {
    const firstCharCache = new WeakMap<MdastNode, string | null>();
    const lastEdgeCache = new WeakMap<MdastNode, string | null>();
    transformNode(tree, catalog, onMissingCatalog, true, true, firstCharCache, lastEdgeCache);
  };
}
