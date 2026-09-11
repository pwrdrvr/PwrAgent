import type { ThreadToolAccounting } from "./contracts/normalized-app-server";

export type ToolAccountingTotals = {
  errorLines: number;
  estimatedOutputTokens: number;
  invocationCount: number;
  noisyInvocationCount: number;
  outputChars: number;
  outputLines: number;
  warningLines: number;
};

export function aggregateToolAccounting(
  toolAccounting: ThreadToolAccounting | undefined,
): ToolAccountingTotals | undefined {
  if (!toolAccounting || toolAccounting.summaries.length === 0) {
    return undefined;
  }
  return toolAccounting.summaries.reduce<ToolAccountingTotals>(
    (totals, summary) => ({
      errorLines: totals.errorLines + summary.errorLines,
      estimatedOutputTokens:
        totals.estimatedOutputTokens + summary.estimatedOutputTokens,
      invocationCount: totals.invocationCount + summary.invocationCount,
      noisyInvocationCount:
        totals.noisyInvocationCount + summary.noisyInvocationCount,
      outputChars: totals.outputChars + summary.outputChars,
      outputLines: totals.outputLines + summary.outputLines,
      warningLines: totals.warningLines + summary.warningLines,
    }),
    {
      errorLines: 0,
      estimatedOutputTokens: 0,
      invocationCount: 0,
      noisyInvocationCount: 0,
      outputChars: 0,
      outputLines: 0,
      warningLines: 0,
    },
  );
}
