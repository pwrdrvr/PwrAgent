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
  node.children = nextChildren;
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
