import { compareUsageLinesAscending, type PricingUsageLine } from "@pwragent/shared/thread-pricing-display";

type Node = {
  row: PricingUsageLine;
  size: number;
  height: number;
  left?: Node;
  right?: Node;
};

function refresh(node: Node): Node {
  node.height = 1 + Math.max(node.left?.height ?? 0, node.right?.height ?? 0);
  node.size = 1 + (node.left?.size ?? 0) + (node.right?.size ?? 0);
  return node;
}

function rotate(node: Node, up: "left" | "right"): Node {
  const down = up === "left" ? "right" : "left";
  const root = node[up]!;
  node[up] = root[down];
  root[down] = refresh(node);
  return refresh(root);
}

function balance(node: Node): Node {
  const diff = (node.left?.height ?? 0) - (node.right?.height ?? 0);
  if (Math.abs(diff) <= 1) return refresh(node);
  const up = diff > 0 ? "left" : "right";
  const down = up === "left" ? "right" : "left";
  const child = node[up]!;
  if ((child[down]?.height ?? 0) > (child[up]?.height ?? 0)) node[up] = rotate(child, down);
  return rotate(node, up);
}

type Compare = (left: PricingUsageLine, right: PricingUsageLine) => number;

function update(node: Node | undefined, row: PricingUsageLine, add: boolean, compare: Compare): Node | undefined {
  if (!node) return add ? { row, size: 1, height: 1 } : undefined;
  const cmp = compare(row, node.row);
  if (cmp < 0) node.left = update(node.left, row, add, compare);
  else if (cmp > 0) node.right = update(node.right, row, add, compare);
  else if (add) node.row = row;
  else {
    if (!node.right) return node.left;
    if (!node.left) return node.right;
    let successor = node.right;
    while (successor.left) successor = successor.left;
    node.row = successor.row;
    node.right = update(node.right, successor.row, false, compare);
  }
  return balance(node);
}

/** Rank-selectable AVL order. Moving an old orphan anchor does not shift the
 * rest of the thread, and deep page offsets skip whole subtrees. */
export class OrderedPricingRows {
  private root?: Node;
  constructor(private readonly compare: Compare = compareUsageLinesAscending) {}

  get size(): number { return this.root?.size ?? 0; }

  update(row: PricingUsageLine, add: boolean): void {
    this.root = update(this.root, row, add, this.compare);
  }

  newest(): PricingUsageLine | undefined {
    let node = this.root;
    while (node?.right) node = node.right;
    return node?.row;
  }

  page(offset = 0, limit = this.size): PricingUsageLine[] {
    const result: PricingUsageLine[] = [];
    const end = offset + limit;
    const visit = (node: Node | undefined, start: number) => {
      if (!node || start >= end || start + node.size <= offset) return;
      const rank = start + (node.right?.size ?? 0);
      visit(node.right, start);
      if (rank >= offset && rank < end) result.push(node.row);
      visit(node.left, rank + 1);
    };
    visit(this.root, 0);
    return result;
  }
}
