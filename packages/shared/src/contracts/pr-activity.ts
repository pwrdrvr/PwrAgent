/** How an event reads at a glance; set where the outcome is known. */
export type PrActivityTone = "ok" | "active" | "warning" | "error";

/** Bounded diagnostic history for the local app process; never agent token usage. */
export type PrActivityEvent = {
  id: number;
  occurredAt: number;
  category: "check" | "repair" | "budget";
  source: string;
  message: string;
  threadKeys: string[];
  prKeys: string[];
  /** Absent for routine events, which render neutral. */
  tone?: PrActivityTone;
  /**
   * How many identical observations this row stands for, when the journal
   * coalesced repeats; `occurredAt` is then the latest and this the first.
   */
  repeats?: number;
  firstOccurredAt?: number;
  budget?: "polling" | "repair";
  delta?: number;
  availableTokens?: number;
};

export type PrActivityBudgetLimits = {
  capacity: number;
  refillPerMinute: number;
};

export type PrActivitySnapshot = {
  startedAt: number;
  droppedEvents: number;
  events: PrActivityEvent[];
  /** Main-owned cached metadata, deduplicated across the retained history. */
  threadTitles?: Record<string, string>;
  prUrls?: Record<string, string>;
  monitoring?: {
    backgroundPollingEnabled: boolean;
    autoFixAllowed: boolean;
    repairBudgetPaused: boolean;
    /**
     * The PR request bucket lives in memory, so its balance is current as of
     * the snapshot. The repair bucket is durable and refills on read, so the
     * snapshot carries only its limits; the balance comes from the history.
     */
    pollingBudget?: PrActivityBudgetLimits & { availableTokens: number };
    repairBudget?: PrActivityBudgetLimits;
  };
};
