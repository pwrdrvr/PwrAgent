/** Local stand-in until a provider names the turn. */
export function buildPendingTurnId(threadId: string): string {
  return `pending:${threadId}`;
}

/** ACP's timestamped turn IDs identify admitted turns and are distinct from this stand-in. */
export function isPendingTurnId(threadId: string, turnId: string): boolean {
  return turnId === buildPendingTurnId(threadId);
}
