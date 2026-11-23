export type ThreadGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

export type ThreadGoalView = {
  threadId: string;
  objective: string;
  status: ThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  updatedAt: number;
};

export type ThreadGoalState = {
  supported: boolean;
  goal: ThreadGoalView | null;
  pausedForMessage?: boolean;
  activationQueued?: boolean;
  activationHoldReason?: string;
  confirmationRequired?: boolean;
  refusal?: string;
};

export type ThreadGoalRequest = {
  threadId: string;
  action: "read" | "set" | "pause" | "resume" | "clear" | "cancel";
  objective?: string;
  confirmedObjective?: string;
};

export const CODEX_GOAL_METHODS = ["thread/goal/get", "thread/goal/set", "thread/goal/clear"] as const;

export function validateThreadGoalObjective(objective: string): string | undefined {
  let length = 0;
  for (const _scalar of objective) length++;
  if (length === 0) return "Enter an objective for this goal.";
  if (length > 4000) {
    return `The goal objective is ${length.toLocaleString("en-US")} characters. Codex supports at most 4,000. Shorten it and send /goal again. The current goal was not changed.`;
  }
}
