import type { ReactionEmojiCatalog } from "../navigation/reaction-emoji-catalog";
import { replaceEmojiShortcodesInText } from "../../lib/emoji-shortcodes";

type MdastNode = {
  type: string;
  value?: string;
  children?: MdastNode[];
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

function firstTextChar(node: MdastNode): string | undefined {
  if (node.type === "text" && typeof node.value === "string" && node.value.length > 0) {
    return node.value[0];
  }
  if (INLINE_FORMATTING_TYPES.has(node.type) && node.children) {
    for (const child of node.children) {
      const char = firstTextChar(child);
      if (char !== undefined) {
        return char;
      }
    }
  }
  return undefined;
}

function lastTextChar(node: MdastNode): string | undefined {
  if (node.type === "text" && typeof node.value === "string" && node.value.length > 0) {
    return node.value[node.value.length - 1];
  }
  if (INLINE_FORMATTING_TYPES.has(node.type) && node.children) {
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const char = lastTextChar(node.children[index]!);
      if (char !== undefined) {
        return char;
      }
    }
  }
  return undefined;
}

function allowsLeadingFromSibling(sibling: MdastNode | undefined, fallback: boolean): boolean {
  if (!sibling) {
    return fallback;
  }
  if (sibling.type === "break") {
    return true;
  }
  const trailing = lastTextChar(sibling);
  return trailing !== undefined && /\s/.test(trailing);
}

function allowsTrailingToSibling(sibling: MdastNode | undefined, fallback: boolean): boolean {
  if (!sibling) {
    return fallback;
  }
  if (sibling.type === "break") {
    return true;
  }
  const leading = firstTextChar(sibling);
  return leading !== undefined && (/\s/.test(leading) || TRAILING_PUNCTUATION_PATTERN.test(leading));
}

function transformNode(
  node: MdastNode,
  catalog: ReactionEmojiCatalog | undefined,
  parentAllowsLeading: boolean,
  parentAllowsTrailing: boolean,
): void {
  if (!node.children || SKIPPED_PARENT_TYPES.has(node.type)) {
    return;
  }

  const isInlineWrapper = INLINE_FORMATTING_TYPES.has(node.type);
  const baseLeading = isInlineWrapper ? parentAllowsLeading : true;
  const baseTrailing = isInlineWrapper ? parentAllowsTrailing : true;

  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index]!;
    const prev = index > 0 ? node.children[index - 1] : undefined;
    const next = index + 1 < node.children.length ? node.children[index + 1] : undefined;
    const allowLeadingStart = allowsLeadingFromSibling(prev, baseLeading);
    const allowTrailingEnd = allowsTrailingToSibling(next, baseTrailing);

    if (child.type === "text" && typeof child.value === "string") {
      child.value = replaceEmojiShortcodesInText(child.value, {
        catalog,
        allowLeadingStart,
        allowTrailingEnd,
      });
      continue;
    }

    transformNode(child, catalog, allowLeadingStart, allowTrailingEnd);
  }
}

/**
 * Block-local Remark plugin that expands boundary-safe `:shortcode:` tokens in
 * prose text nodes while leaving code blocks, inline code, links/URLs, math,
 * and technical identifiers (`std::vector`, `foo:bar:baz`, `12:30:00`) intact.
 */
export function remarkEmojiShortcodes(catalog?: ReactionEmojiCatalog) {
  return (tree: MdastNode): void => {
    transformNode(tree, catalog, true, true);
  };
}
