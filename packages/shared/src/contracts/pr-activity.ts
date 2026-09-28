/** Bounded diagnostic history for the local app process; never agent token usage. */
export type PrActivityEvent = {
  id: number;
  occurredAt: number;
  category: "check" | "repair" | "budget";
  source: string;
  message: string;
  threadKeys: string[];
  prKeys: string[];
  budget?: "polling" | "repair";
  delta?: number;
  availableTokens?: number;
};

export type PrActivitySnapshot = {
  startedAt: number;
  droppedEvents: number;
  events: PrActivityEvent[];
  monitoring?: {
    backgroundPollingEnabled: boolean;
    autoFixAllowed: boolean;
    repairBudgetPaused: boolean;
  };
};
