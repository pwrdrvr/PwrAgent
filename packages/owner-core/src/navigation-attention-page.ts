import { createHash } from "node:crypto";
import type { NavigationDirectorySummary, NavigationIdentity, NavigationQueryEntry, NavigationRow } from "@pwragent/shared/contracts/navigation";
import { DIRECTORY_GIT_PROOF_MAX_KEYS } from "@pwragent/shared/navigation-metadata-dependencies";

export type AttentionGitInputs = {
  links: number;
  paths: ReadonlySet<string>;
  checkouts: ReadonlySet<NavigationDirectorySummary>;
};

const emptyGitInputs: AttentionGitInputs = { links: 0, paths: new Set(), checkouts: new Set() };

function combineGitInputs(size: number, inputs: (AttentionGitInputs | undefined)[]): AttentionGitInputs | undefined {
  if (size > 512) return undefined;
  const paths = new Set<string>();
  const checkouts = new Set<NavigationDirectorySummary>();
  let links = 0;
  for (const input of inputs) {
    if (!input) return undefined;
    links += input.links;
    if (links > 512) return undefined;
    for (const path of input.paths) paths.add(path);
    for (const checkout of input.checkouts) checkouts.add(checkout);
    if (paths.size > 64 || checkouts.size > DIRECTORY_GIT_PROOF_MAX_KEYS) return undefined;
  }
  return { links, paths, checkouts };
}

// The priority depends only on identity. The same ordered content therefore
// has the same digest even when it is reached through a different edit history.
type Item = { key: string; priority: number; digest?: string; bytes?: number; deferred?: boolean; git?: AttentionGitInputs };
type Tree<T extends Item> = {
  item: T;
  left?: Tree<T>;
  right?: Tree<T>;
  size: number;
  deferred: number;
  bytes: number;
  hash?: string;
  git?: AttentionGitInputs;
};
type Compare<T> = (left: T, right: T) => number;

function node<T extends Item>(item: T, left?: Tree<T>, right?: Tree<T>): Tree<T> {
  const size = 1 + (left?.size ?? 0) + (right?.size ?? 0);
  return {
    item, left, right, size,
    deferred: Number(item.deferred ?? false) + (left?.deferred ?? 0) + (right?.deferred ?? 0),
    bytes: (item.bytes ?? 0) + (left?.bytes ?? 0) + (right?.bytes ?? 0),
    hash: item.digest && createHash("sha256").update(left?.hash ?? "-").update(item.digest).update(right?.hash ?? "-").digest("base64url"),
    git: item.digest ? combineGitInputs(size, [left ? left.git : emptyGitInputs, item.git, right ? right.git : emptyGitInputs]) : undefined,
  };
}

function precedes(left: Item, right: Item): boolean {
  return left.priority < right.priority || (left.priority === right.priority && left.key < right.key);
}

function insert<T extends Item>(tree: Tree<T> | undefined, item: T, compare: Compare<T>): Tree<T> {
  if (!tree) return node(item);
  const order = compare(item, tree.item);
  if (order === 0) return node(item, tree.left, tree.right);
  if (order < 0) {
    const left = insert(tree.left, item, compare);
    if (precedes(left.item, tree.item)) return node(left.item, left.left, node(tree.item, left.right, tree.right));
    return node(tree.item, left, tree.right);
  }
  const right = insert(tree.right, item, compare);
  if (precedes(right.item, tree.item)) return node(right.item, node(tree.item, tree.left, right.left), right.right);
  return node(tree.item, tree.left, right);
}

function build<T extends Item>(items: T[], compare: Compare<T>): Tree<T> | undefined {
  type Draft = { item: T; left?: Draft; right?: Draft };
  const stack: Draft[] = [];
  for (const item of items.sort(compare)) {
    const draft: Draft = { item };
    while (stack.length && precedes(item, stack.at(-1)!.item)) draft.left = stack.pop();
    const parent = stack.at(-1);
    if (parent) parent.right = draft;
    stack.push(draft);
  }
  const measure = (draft: Draft | undefined): Tree<T> | undefined =>
    draft && node(draft.item, measure(draft.left), measure(draft.right));
  return measure(stack[0]);
}

function merge<T extends Item>(left?: Tree<T>, right?: Tree<T>): Tree<T> | undefined {
  if (!left || !right) return left ?? right;
  return precedes(left.item, right.item)
    ? node(left.item, left.left, merge(left.right, right))
    : node(right.item, merge(left, right.left), right.right);
}

function remove<T extends Item>(tree: Tree<T> | undefined, item: T, compare: Compare<T>): Tree<T> | undefined {
  if (!tree) return tree;
  const order = compare(item, tree.item);
  if (order === 0) return merge(tree.left, tree.right);
  return order < 0 ? node(tree.item, remove(tree.left, item, compare), tree.right)
    : node(tree.item, tree.left, remove(tree.right, item, compare));
}

function find<T extends Item>(tree: Tree<T> | undefined, key: string): T | undefined {
  while (tree && key !== tree.item.key) tree = key < tree.item.key ? tree.left : tree.right;
  return tree?.item;
}

function position<T extends Item>(tree: Tree<T> | undefined, item: T, compare: Compare<T>): number {
  let start = 0;
  while (tree) {
    const order = compare(item, tree.item);
    const leftSize = tree.left?.size ?? 0;
    if (order === 0) return start + leftSize;
    if (order > 0) start += leftSize + 1;
    tree = order < 0 ? tree.left : tree.right;
  }
  return -1;
}

function at<T extends Item>(tree: Tree<T> | undefined, offset: number): T | undefined {
  while (tree) {
    const leftSize = tree.left?.size ?? 0;
    if (offset === leftSize) return tree.item;
    if (offset < leftSize) tree = tree.left;
    else {
      offset -= leftSize + 1;
      tree = tree.right;
    }
  }
  return undefined;
}

function collectDeferred(tree: Tree<RankedRow> | undefined, offset: number, start: number, end: number, result: number[]): void {
  if (!tree?.deferred || offset >= end || offset + tree.size <= start) return;
  const here = offset + (tree.left?.size ?? 0);
  collectDeferred(tree.left, offset, start, end, result);
  if (tree.item.deferred && here >= start && here < end) result.push(here);
  collectDeferred(tree.right, here + 1, start, end, result);
}

export type AttentionPageRow = {
  row: NavigationRow;
  parent?: NavigationIdentity;
  updatedAt: number;
  inputOrder: number;
  rank?: number;
  deferred: boolean;
  git?: AttentionGitInputs;
};

type RankedRow = Item & AttentionPageRow;
type IdentityItem = Item & { ranked: RankedRow };

function compareRank(left: RankedRow, right: RankedRow): number {
  return (right.rank ?? 0) - (left.rank ?? 0) || right.updatedAt - left.updatedAt
    || left.key.localeCompare(right.key) || left.inputOrder - right.inputOrder;
}

function compareKey(left: Item, right: Item): number {
  return left.key < right.key ? -1 : Number(left.key !== right.key);
}

export function attentionPageKey(ref: NavigationIdentity): string {
  return [ref.ownerInstanceId ?? "local", ref.backend, ref.threadId].join("\u0000");
}

function rankedRow(value: AttentionPageRow): RankedRow {
  const key = attentionPageKey(value.row.ref);
  const json = JSON.stringify([value.row, value.rank, value.parent, value.deferred]);
  return { ...value, key, priority: createHash("sha256").update(key).digest().readUInt32BE(),
    digest: createHash("sha256").update(json).digest("base64url"), bytes: Buffer.byteLength(json) + 256 };
}

/** Immutable order and identity indexes. Cursor generations share untouched
 * branches, while positions and parent placement are derived on page output. */
export class NavigationAttentionPageRows {
  private ranks?: Tree<RankedRow>;
  private identities?: Tree<IdentityItem>;

  static from(rows: AttentionPageRow[]): NavigationAttentionPageRows {
    const result = new NavigationAttentionPageRows();
    const ranked = rows.map(rankedRow);
    result.ranks = build(ranked, compareRank);
    result.identities = build(ranked.map((row) => ({ key: row.key, priority: row.priority, ranked: row })), compareKey);
    return result;
  }

  get length(): number { return this.ranks?.size ?? 0; }
  get hasDeferred(): boolean { return Boolean(this.ranks?.deferred); }
  get gitInputs(): AttentionGitInputs | undefined { return this.ranks ? this.ranks.git : emptyGitInputs; }
  get digest(): { hash: string; bytes: number; length: number } {
    return { hash: this.ranks?.hash ?? "", bytes: this.ranks?.bytes ?? 0, length: this.length };
  }

  fork(): NavigationAttentionPageRows {
    const copy = new NavigationAttentionPageRows();
    copy.ranks = this.ranks;
    copy.identities = this.identities;
    return copy;
  }

  set(key: string, value: AttentionPageRow | undefined): void {
    const old = find(this.identities, key);
    const item = value && rankedRow(value);
    if (old && (!item || compareRank(old.ranked, item) !== 0)) {
      this.ranks = remove(this.ranks, old.ranked, compareRank);
    }
    if (item) {
      this.ranks = insert(this.ranks, item, compareRank);
      this.identities = insert(this.identities, { key, priority: item.priority, ranked: item }, compareKey);
    } else if (old) this.identities = remove(this.identities, old, compareKey);
  }

  at(offset: number): NavigationQueryEntry | undefined {
    const item = at(this.ranks, offset);
    if (!item) return undefined;
    const parent = item.parent && find(this.identities, attentionPageKey(item.parent));
    return { row: item.row, orderKey: offset.toString(36).padStart(10, "0"),
      ...(item.rank !== undefined ? { attentionRank: item.rank } : {}),
      placement: parent ? { kind: "child", parent: item.parent! } : { kind: "root" } };
  }

  position(ref: NavigationIdentity): number {
    const item = find(this.identities, attentionPageKey(ref));
    const stored = item?.ranked.row.ref;
    return item && stored?.backend === ref.backend && stored.threadId === ref.threadId && stored.ownerInstanceId === ref.ownerInstanceId
      ? position(this.ranks, item.ranked, compareRank) : -1;
  }

  deferredPositions(start: number, count: number): number[] {
    const result: number[] = [];
    collectDeferred(this.ranks, 0, start, start + count, result);
    return result;
  }

  allDeferredPositions(limit: number): number[] | undefined {
    return (this.ranks?.deferred ?? 0) <= limit ? this.deferredPositions(0, this.length) : undefined;
  }
}
