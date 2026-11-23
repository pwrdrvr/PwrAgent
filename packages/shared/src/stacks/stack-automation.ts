export type StackLayerHealth =
  | "in_sync" | "needs_restack" | "parent_merged" | "needs_push"
  | "drift" | "remote_ahead" | "held" | "ambiguous" | "unknown";

export const STACK_UNSETTLED_REASONS = [
  "stack operation in flight", "merging", "repair in progress", "merge conflict",
  "needs sync", "needs restack", "needs push", "remote head changed",
  "CI failing", "CI running", "settlement unknown",
] as const;
export type StackUnsettledReason = (typeof STACK_UNSETTLED_REASONS)[number];

export type StackAutomationBlock = {
  branch: string;
  number?: number;
  reason: StackUnsettledReason;
};

export type StackSettlement = {
  branch: string;
  number?: number;
  health: StackLayerHealth;
  merged?: boolean;
  closed?: boolean;
  merging?: boolean;
  conflict?: boolean;
  repair?: boolean;
  checks?: "passing" | "failing" | "pending" | "none" | "unknown";
  checksRunning?: boolean;
};

export function stackUnsettledReason(layer: StackSettlement): StackUnsettledReason | undefined {
  if (layer.health === "held") return "stack operation in flight";
  if (layer.merged) return undefined;
  if (layer.closed) return "settlement unknown";
  if (layer.merging) return "merging";
  if (layer.health === "parent_merged") return "needs sync";
  if (layer.health === "needs_restack") return "needs restack";
  if (layer.health === "remote_ahead" || layer.health === "drift") return "remote head changed";
  if (layer.health === "needs_push") return "needs push";
  if (layer.repair) return "repair in progress";
  if (layer.conflict) return "merge conflict";
  // Wait for the whole run. A passing subset can still turn red, and an
  // early failure can resolve as the forge finishes evaluating the head.
  if (layer.checksRunning || layer.checks === "pending") return "CI running";
  if (layer.checks === "failing") return "CI failing";
  if (layer.conflict === undefined || layer.health !== "in_sync" || (layer.checks !== "passing" && layer.checks !== "none")) {
    return "settlement unknown";
  }
}

/** Bottom-first input. A blocker remains the same for every layer above it. */
export function stackAutomationGates(layers: readonly StackSettlement[]): Array<{
  heldBy?: StackAutomationBlock;
  unsettled?: StackUnsettledReason;
}> {
  let heldBy: StackAutomationBlock | undefined;
  return layers.map((layer) => {
    const unsettled = stackUnsettledReason(layer);
    const gate = { ...(heldBy ? { heldBy } : {}), ...(unsettled ? { unsettled } : {}) };
    if (!heldBy && unsettled) {
      heldBy = { branch: layer.branch, ...(layer.number === undefined ? {} : { number: layer.number }), reason: unsettled };
    }
    return gate;
  });
}

export function describeStackAutomationBlock(block: StackAutomationBlock, separator = ": "): string {
  return `Held by ${block.number === undefined ? block.branch : `#${block.number}`}${separator}${block.reason}`;
}

/** A stale head must be replayed and published before dispatchers act on its CI. */
export function stackDispatchBlock(layer: {
  branch: string;
  pullRequest?: { number: number };
  heldBy?: StackAutomationBlock;
  unsettled?: StackUnsettledReason;
}): StackAutomationBlock | undefined {
  if (layer.heldBy) return layer.heldBy;
  const reason = layer.unsettled;
  if (reason === "needs restack" || reason === "needs sync" || reason === "needs push"
    || reason === "stack operation in flight" || reason === "remote head changed") {
    return { branch: layer.branch, number: layer.pullRequest?.number, reason };
  }
}

/** Only the first unsettled layer may advance, and only if Git work is due. */
export function nextStackAdvance<T extends { heldBy?: StackAutomationBlock; unsettled?: StackUnsettledReason }>(
  layers: readonly T[],
): T | undefined {
  return layers.find(({ heldBy, unsettled }) => !heldBy
    && (unsettled === "needs restack" || unsettled === "needs sync" || unsettled === "needs push"));
}
