import { parsePullRequestUrl } from "../../lib/pull-request-links";

type MdastNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MdastNode[];
};

type RemarkPlugin = () => (tree: MdastNode) => void;

const PULL_REQUEST_REFERENCE_HOST = "pull-request";
const PULL_REQUEST_REFERENCE_PREFIX =
  `pwragent://${PULL_REQUEST_REFERENCE_HOST}/`;
const SKIPPED_PARENT_TYPES = new Set([
  "code",
  "definition",
  "html",
  "image",
  "imageReference",
  "inlineCode",
  "link",
  "linkReference",
]);

/**
 * Mark bare `#123` text as an in-app PR reference without guessing whether it
 * is actually a PR. The renderer resolves the number against live,
 * repository-scoped metadata and falls back to the authored text when there is
 * no unique match.
 *
 * Existing links and code are deliberately left alone. Full PR URLs already
 * have their own link hydration path, while code should stay literal.
 *
 * Agents often name one PR twice, as `#123 (https://…/pull/123)` or the
 * reverse. Both halves would become chips for the same PR, so that
 * parenthetical collapses to the URL's chip, which names its repository
 * exactly.
 */
export const remarkPullRequestReferences: RemarkPlugin = () => (tree) => {
  replacePullRequestReferences(tree);
};

export function parsePullRequestNumberHref(href: string): number | undefined {
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return undefined;
  }

  if (
    parsed.protocol !== "pwragent:"
    || parsed.hostname !== PULL_REQUEST_REFERENCE_HOST
  ) {
    return undefined;
  }

  const numberText = parsed.pathname.replace(/^\/+/, "");
  if (!/^[1-9]\d*$/.test(numberText)) {
    return undefined;
  }
  const number = Number.parseInt(numberText, 10);
  return Number.isSafeInteger(number) ? number : undefined;
}

function replacePullRequestReferences(node: MdastNode): void {
  if (!node.children || SKIPPED_PARENT_TYPES.has(node.type)) {
    return;
  }

  const nextChildren: MdastNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      nextChildren.push(...splitPullRequestReferences(child.value));
      continue;
    }
    replacePullRequestReferences(child);
    nextChildren.push(child);
  }
  node.children = collapseRedundantPullRequestPairs(nextChildren);
}

const OPEN_PARENTHESIS = /^[ \t]*\([ \t]*$/;
const CLOSE_PARENTHESIS = /^[ \t]*\)/;

/**
 * Collapse `#N (<PR N link>)` and `<PR N link> (#N)` to the link alone. The
 * number must match, so `#12 (…/pull/34)` keeps both chips.
 */
function collapseRedundantPullRequestPairs(children: MdastNode[]): MdastNode[] {
  const result: MdastNode[] = [];
  for (let index = 0; index < children.length; index += 1) {
    const [first, open, second, close] = children.slice(index, index + 4);
    const urlLink = first && open && second && close
      && isText(open, OPEN_PARENTHESIS)
      && isText(close, CLOSE_PARENTHESIS)
      ? redundantPairUrlLink(first, second)
      : undefined;
    if (!urlLink) {
      result.push(children[index] as MdastNode);
      continue;
    }

    result.push(urlLink);
    const rest = (close?.value ?? "").replace(CLOSE_PARENTHESIS, "");
    if (rest) {
      result.push({ type: "text", value: rest });
    }
    index += 3;
  }
  return result;
}

function redundantPairUrlLink(
  first: MdastNode,
  second: MdastNode,
): MdastNode | undefined {
  const firstNumber = pullRequestReferenceNumber(first);
  const secondNumber = pullRequestReferenceNumber(second);
  if (firstNumber !== undefined) {
    return pullRequestUrlNumber(second) === firstNumber ? second : undefined;
  }
  if (secondNumber !== undefined) {
    return pullRequestUrlNumber(first) === secondNumber ? first : undefined;
  }
  return undefined;
}

function pullRequestReferenceNumber(node: MdastNode): number | undefined {
  return node.type === "link" && node.url
    ? parsePullRequestNumberHref(node.url)
    : undefined;
}

function pullRequestUrlNumber(node: MdastNode): number | undefined {
  return node.type === "link" && node.url
    ? parsePullRequestUrl(node.url)?.number
    : undefined;
}

function isText(node: MdastNode, pattern: RegExp): boolean {
  return node.type === "text"
    && typeof node.value === "string"
    && pattern.test(node.value);
}

function splitPullRequestReferences(value: string): MdastNode[] {
  const nodes: MdastNode[] = [];
  const pattern = /(^|[^\w#])#([1-9]\d*)\b/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value)) !== null) {
    const prefix = match[1] ?? "";
    const numberText = match[2] ?? "";
    const number = Number.parseInt(numberText, 10);
    if (!Number.isSafeInteger(number)) {
      continue;
    }

    const referenceStart = match.index + prefix.length;
    if (referenceStart > cursor) {
      nodes.push({ type: "text", value: value.slice(cursor, referenceStart) });
    }
    const label = `#${numberText}`;
    nodes.push({
      type: "link",
      url: `${PULL_REQUEST_REFERENCE_PREFIX}${numberText}`,
      children: [{ type: "text", value: label }],
    });
    cursor = referenceStart + label.length;
  }

  if (cursor === 0) {
    return [{ type: "text", value }];
  }
  if (cursor < value.length) {
    nodes.push({ type: "text", value: value.slice(cursor) });
  }
  return nodes;
}
