// Builds the clipboard flavors for a selection inside rendered transcript
// Markdown.
//
// Chromium's own text/plain for a selection drops list numbers and bullets
// (they are `::marker` boxes, not text) and loses some line breaks at nested
// list edges. Plain-text targets such as X, a terminal, or a GitHub textarea
// then receive a flattened run of prose. This module writes Markdown as
// text/plain instead, matching what the message copy button puts there, plus a
// clean semantic text/html so rich targets and the composer keep the
// structure.
//
// It walks the live DOM rather than `Range.cloneContents()`: a clone of a list
// that starts at item 3 has no way to know it was item 3.

import { decodeMarkdownDestination } from "../../lib/directory-references";

export type SelectionClipboard = {
  html: string;
  text: string;
};

const DROPPED_TAGS = new Set([
  "button",
  "script",
  "select",
  "style",
  "svg",
  "textarea",
]);

// Tags kept as-is in the clean tree. Anything else (span, div, sup…) is
// unwrapped so only its children remain.
const SEMANTIC_TAGS = new Set([
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);

const TAG_ALIASES: Record<string, string> = {
  b: "strong",
  i: "em",
  s: "del",
  strike: "del",
};

const TABLE_SECTION_TAGS = new Set(["tbody", "thead", "tr"]);

const BLOCK_TAGS = new Set([
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "table",
  "ul",
]);

/**
 * Returns the clipboard flavors for `range`, or `undefined` when the browser's
 * own copy is already right: the range leaves `root`, sits inside one text
 * node, or sits inside code or math, where the text is verbatim.
 */
export function buildSelectionClipboard(
  range: Range,
  root: Element,
): SelectionClipboard | undefined {
  const common = range.commonAncestorContainer;
  if (!root.contains(common) || !(common instanceof Element)) {
    return undefined;
  }
  const verbatim = common.closest("pre, code, .katex, .mermaid-diagram");
  if (verbatim && root.contains(verbatim)) {
    return undefined;
  }

  const tree = cloneSelectedTree(selectionStart(common), range);
  const container = document.createElement("div");
  container.append(tree);
  if (!hasContent(container)) {
    return undefined;
  }

  return {
    html: container.innerHTML,
    text: blocksToMarkdown(Array.from(container.childNodes)),
  };
}

// Where the walk starts. A selection inside one list item copies that item's
// content without its number; one across table cells needs the table for its
// row structure.
function selectionStart(common: Element): Element {
  const tag = common.tagName.toLowerCase();
  if (tag === "tr" || tag === "thead" || tag === "tbody" || tag === "tfoot") {
    return common.closest("table") ?? common;
  }
  return common;
}

function cloneSelectedTree(start: Element, range: Range): Node {
  if (start.tagName.toLowerCase() === "li") {
    // Words from one item copy without its marker. A selection that reaches
    // the item's own blocks, such as its sub-bullets, keeps the marker.
    const content = cloneChildren(start, range);
    const list = start.parentElement;
    if (list && isList(list) && Array.from(content.childNodes).some(isBlock)) {
      return cloneSelectedNode(list, range) ?? content;
    }
    return content;
  }
  return cloneSelectedNode(start, range) ?? document.createDocumentFragment();
}

function cloneChildren(element: Element, range: Range): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const child of Array.from(element.childNodes)) {
    const clone = cloneSelectedNode(child, range);
    if (clone) {
      fragment.append(clone);
    }
  }
  return fragment;
}

function cloneSelectedNode(node: Node, range: Range): Node | null {
  if (!range.intersectsNode(node)) {
    return null;
  }

  if (node.nodeType === Node.TEXT_NODE) {
    let text = node.textContent ?? "";
    if (node === range.endContainer) {
      text = text.slice(0, range.endOffset);
    }
    if (node === range.startContainer) {
      text = text.slice(range.startOffset);
    }
    return text ? document.createTextNode(text) : null;
  }

  if (!(node instanceof Element)) {
    return null;
  }

  const sourceTag = node.tagName.toLowerCase();
  if (DROPPED_TAGS.has(sourceTag)) {
    return null;
  }

  // A PR chip renders a short `org/repo#n` label; the URL is what can
  // hydrate again wherever the text lands.
  if (node.hasAttribute("data-pr-chip")) {
    const href = node.getAttribute("data-pr-url");
    if (!href) {
      return document.createTextNode(node.textContent ?? "");
    }
    const link = document.createElement("a");
    link.href = href;
    link.textContent = href;
    return link;
  }

  // A rendered diagram is an image and a toolbar. Its source is what reads
  // back, so the whole fence copies even when the selection grazes it.
  if (node.classList.contains("mermaid-diagram")) {
    const source = node.getAttribute("data-mermaid-source");
    if (!source) {
      return null;
    }
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.className = "language-mermaid";
    code.textContent = source;
    pre.append(code);
    return pre;
  }

  if (node.classList.contains("katex-display")) {
    const paragraph = document.createElement("p");
    paragraph.textContent = `$$${mathSource(node)}$$`;
    return paragraph;
  }
  if (node.classList.contains("katex")) {
    return document.createTextNode(`$${mathSource(node)}$`);
  }

  if (node.getAttribute("aria-hidden") === "true") {
    return null;
  }

  if (sourceTag === "input") {
    if (node.getAttribute("type") !== "checkbox") {
      return null;
    }
    const checkbox = document.createElement("input");
    checkbox.setAttribute("type", "checkbox");
    checkbox.setAttribute("disabled", "");
    if (node.hasAttribute("checked") || (node as HTMLInputElement).checked) {
      checkbox.setAttribute("checked", "");
    }
    return checkbox;
  }

  const tag = TAG_ALIASES[sourceTag] ?? sourceTag;
  if (!SEMANTIC_TAGS.has(tag)) {
    return cloneChildren(node, range);
  }

  const clone = document.createElement(tag);
  copyAllowedAttributes(node, clone);

  if (tag === "ol") {
    appendListItems(node, clone, range);
  } else if (tag === "tr") {
    appendRowCells(node, clone, range);
  } else {
    clone.append(cloneChildren(node, range));
  }

  if (isPrunable(tag) && !hasContent(clone)) {
    return null;
  }
  if (tag === "table") {
    replaceWithFullHead(node, clone);
  }
  return clone;
}

// Blocks that are dropped when the selection only grazed them, as when a
// triple-click selection ends at offset 0 of the next paragraph.
function isPrunable(tag: string): boolean {
  return tag !== "hr" && (BLOCK_TAGS.has(tag) || TABLE_SECTION_TAGS.has(tag));
}

// A row keeps a cell for every column, empty where the selection did not
// reach, so values stay under their own headers.
function appendRowCells(source: Element, clone: Element, range: Range): void {
  for (const child of Array.from(source.childNodes)) {
    const tag = tagOf(child);
    if ((tag === "td" || tag === "th") && !range.intersectsNode(child)) {
      clone.append(document.createElement(tag));
      continue;
    }
    const childClone = cloneSelectedNode(child, range);
    if (childClone) {
      clone.append(childClone);
    }
  }
}

// A Markdown table needs its header row. Copy the whole original header, so a
// selection that starts in the body or mid-header still names every column.
function replaceWithFullHead(source: Element, clone: Element): void {
  const sourceHead = Array.from(source.children).find(
    (child) => child.tagName.toLowerCase() === "thead",
  );
  if (!sourceHead) {
    return;
  }
  const headRange = document.createRange();
  headRange.selectNodeContents(sourceHead);
  const head = cloneSelectedNode(sourceHead, headRange);
  if (!head) {
    return;
  }
  Array.from(clone.children)
    .filter((child) => child.tagName.toLowerCase() === "thead")
    .forEach((child) => child.remove());
  clone.prepend(head);
}

// Keeps each item's original number, so a selection from item 3 to item 5
// copies as 3., 4., 5.
function appendListItems(source: Element, clone: Element, range: Range): void {
  const parsedStart = Number.parseInt(source.getAttribute("start") ?? "", 10);
  const start = Number.isFinite(parsedStart) ? parsedStart : 1;
  let index = 0;
  let firstNumber: number | undefined;
  for (const child of Array.from(source.childNodes)) {
    const isItem = child instanceof Element && child.tagName.toLowerCase() === "li";
    const itemClone = cloneSelectedNode(child, range);
    if (itemClone) {
      if (isItem && firstNumber === undefined) {
        firstNumber = start + index;
      }
      clone.append(itemClone);
    }
    if (isItem) {
      index += 1;
    }
  }
  if (firstNumber !== undefined && firstNumber !== 1) {
    clone.setAttribute("start", String(firstNumber));
  } else {
    clone.removeAttribute("start");
  }
}

// `ol[start]` is set by appendListItems from the items actually kept.
function copyAllowedAttributes(source: Element, clone: Element): void {
  const tag = clone.tagName.toLowerCase();
  if (tag === "a") {
    const href = source.getAttribute("href");
    if (href) {
      clone.setAttribute("href", href);
    }
  }
  if (tag === "code") {
    const language = codeLanguage(source);
    if (language) {
      clone.setAttribute("class", `language-${language}`);
    }
  }
}

function mathSource(element: Element): string {
  const annotation = element.querySelector('annotation[encoding="application/x-tex"]');
  if (annotation?.textContent) {
    return annotation.textContent.trim();
  }
  return (element.querySelector(".katex-html")?.textContent ?? element.textContent ?? "").trim();
}

// A checkbox alone is not content: a task item the selection only grazed
// would otherwise copy as an empty `- [ ]`.
function hasContent(node: Element | DocumentFragment): boolean {
  return (node.textContent ?? "").trim().length > 0
    || node.querySelector("hr") !== null;
}

function codeLanguage(element: Element): string | undefined {
  const match = /(?:^|\s)language-(\S+)/.exec(element.getAttribute("class") ?? "");
  return match?.[1];
}

function tagOf(node: Node): string | undefined {
  return node instanceof Element ? node.tagName.toLowerCase() : undefined;
}

function isBlock(node: Node): boolean {
  const tag = tagOf(node);
  return tag !== undefined && BLOCK_TAGS.has(tag);
}

function isList(node: Node): boolean {
  const tag = tagOf(node);
  return tag === "ol" || tag === "ul";
}

// Serializes sibling nodes as Markdown blocks. Runs of inline nodes become
// paragraphs. Inside a list item a nested list follows its text on the next
// line, so the list stays tight.
function blocksToMarkdown(nodes: Node[], options: { inListItem?: boolean } = {}): string {
  const blocks: { list: boolean; text: string }[] = [];
  let inlineRun: Node[] = [];
  const flushInline = () => {
    if (inlineRun.length === 0) {
      return;
    }
    const text = paragraphText(inlineRun);
    inlineRun = [];
    if (text) {
      blocks.push({ list: false, text });
    }
  };

  for (const node of nodes) {
    if (!isBlock(node)) {
      inlineRun.push(node);
      continue;
    }
    flushInline();
    const text = blockToMarkdown(node as Element);
    if (text) {
      blocks.push({ list: isList(node), text });
    }
  }
  flushInline();

  return blocks
    .map((block, index) => {
      if (index === 0) {
        return block.text;
      }
      const separator = options.inListItem && block.list ? "\n" : "\n\n";
      return `${separator}${block.text}`;
    })
    .join("");
}

function blockToMarkdown(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const children = Array.from(element.childNodes);
  switch (tag) {
    case "p":
      return paragraphText(children);
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const text = paragraphText(children).replace(/\n+/g, " ");
      return text ? `${"#".repeat(Number(tag[1]))} ${text}` : "";
    }
    case "hr":
      return "---";
    case "pre":
      return fencedCode(element);
    case "blockquote": {
      const inner = blocksToMarkdown(children);
      return inner
        ? inner.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n")
        : "";
    }
    case "ol":
    case "ul":
      return listToMarkdown(element);
    case "table":
      return tableToMarkdown(element);
    case "li":
      return blocksToMarkdown(children, { inListItem: true });
    default:
      return paragraphText(children);
  }
}

function listToMarkdown(list: Element): string {
  const ordered = list.tagName.toLowerCase() === "ol";
  const parsedStart = Number.parseInt(list.getAttribute("start") ?? "", 10);
  let number = Number.isFinite(parsedStart) ? parsedStart : 1;
  const lines: string[] = [];
  for (const item of Array.from(list.children)) {
    if (item.tagName.toLowerCase() !== "li") {
      continue;
    }
    const marker = ordered ? `${number}. ` : "- ";
    number += 1;
    const content = blocksToMarkdown(Array.from(item.childNodes), { inListItem: true });
    if (!content) {
      continue;
    }
    const indent = " ".repeat(marker.length);
    lines.push(
      content
        .split("\n")
        .map((line, index) => (index === 0 ? `${marker}${line}` : line ? `${indent}${line}` : ""))
        .join("\n"),
    );
  }
  return lines.join("\n");
}

function tableToMarkdown(table: Element): string {
  const rows = Array.from(table.querySelectorAll("tr"))
    .map((row) =>
      Array.from(row.children)
        .filter((cell) => {
          const tag = cell.tagName.toLowerCase();
          return tag === "td" || tag === "th";
        })
        .map((cell) =>
          paragraphText(Array.from(cell.childNodes))
            .replace(/\n+/g, " ")
            .replace(/\|/g, "\\|"),
        ),
    )
    .filter((cells) => cells.length > 0);
  if (rows.length === 0) {
    return "";
  }

  const columns = Math.max(...rows.map((cells) => cells.length));
  const formatRow = (cells: string[]) => {
    const padded = [...cells, ...Array<string>(columns - cells.length).fill("")];
    return `| ${padded.join(" | ")} |`;
  };
  return [
    formatRow(rows[0]),
    formatRow(Array<string>(columns).fill("---")),
    ...rows.slice(1).map(formatRow),
  ].join("\n");
}

function fencedCode(pre: Element): string {
  const code = pre.querySelector("code");
  const language = code ? codeLanguage(code) ?? "" : "";
  const text = (pre.textContent ?? "").replace(/\n$/, "");
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

// Joins inline nodes into one paragraph. A `<br>` is the only line break,
// because rendered whitespace collapses everywhere else.
function paragraphText(nodes: Node[]): string {
  return nodes
    .map(inlineToMarkdown)
    .join("")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

function inlineToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? "").replace(/[\t\n\r\f ]+/g, " ");
  }
  if (!(node instanceof Element)) {
    return "";
  }

  const tag = node.tagName.toLowerCase();
  const inner = () => Array.from(node.childNodes).map(inlineToMarkdown).join("");
  switch (tag) {
    case "br":
      return "\n";
    case "strong":
      return wrapInline(inner(), "**");
    case "em":
      return wrapInline(inner(), "*");
    case "del":
      return wrapInline(inner(), "~~");
    case "code":
      return inlineCode(node.textContent ?? "");
    case "a":
      return linkToMarkdown(node, inner());
    case "input":
      return node.hasAttribute("checked") ? "[x] " : "[ ] ";
    default:
      if (isBlock(node)) {
        return `\n${blockToMarkdown(node)}\n`;
      }
      return inner();
  }
}

// Keeps edge spaces outside the markers: `** bold **` is not bold.
function wrapInline(text: string, marker: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  if (!match || !match[2]) {
    return text;
  }
  return `${match[1]}${marker}${match[2]}${marker}${match[3]}`;
}

function inlineCode(text: string): string {
  const content = text.replace(/[\t\n\r\f ]+/g, " ");
  if (!content) {
    return "";
  }
  const fence = "`".repeat(longestBacktickRun(content) + 1);
  const pad = content.startsWith("`") || content.endsWith("`") ? " " : "";
  return `${fence}${pad}${content}${pad}${fence}`;
}

function linkToMarkdown(link: Element, text: string): string {
  const href = link.getAttribute("href") ?? "";
  if (!href) {
    return text;
  }

  if (href.startsWith("file://")) {
    // A transcript file link: inline code that resolved to a file, or a
    // Markdown link to a local path. Copy the code alone, as it was written.
    const children = Array.from(link.childNodes).filter(
      (child) => child.nodeType !== Node.TEXT_NODE || (child.textContent ?? "").trim(),
    );
    if (children.length === 1 && tagOf(children[0]) === "code") {
      return text;
    }
    const path = decodeMarkdownDestination(href.slice("file://".length));
    return `[${text}](${/[\s()]/.test(path) ? `<${path}>` : path})`;
  }

  if (!text || text === href || text === decodeMarkdownDestination(href)) {
    return href;
  }
  return `[${text}](${href})`;
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) {
    longest = Math.max(longest, run.length);
  }
  return longest;
}
