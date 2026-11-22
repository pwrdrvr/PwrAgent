import type { ThreadTodo, ThreadTodoCiApproval } from "@pwragent/shared/contracts/thread-todos";

export function threadTodoCiApprovals(todo: ThreadTodo): ThreadTodoCiApproval[] {
  return todo.status === "open"
    ? (todo.ciApprovals ?? []).filter((approval) => approval.url.startsWith("https://"))
    : [];
}

export function threadTodoCiApprovalTitle(approvals: readonly ThreadTodoCiApproval[]): string | undefined {
  if (approvals.length === 0) return undefined;
  const [approval] = approvals;
  return approvals.length === 1 && approval?.environments.length === 1
    ? `Review ${approval.environments[0]}`
    : "Review deployments";
}

/** What one Approve click does, said before it is sent. */
export function confirmCiApprovalText(approval: ThreadTodoCiApproval, remote: boolean): string {
  const run = [`run #${approval.runId}`, approval.attempt ? `attempt ${approval.attempt}` : undefined,
    approval.headSha?.slice(0, 12)].filter(Boolean).join(", ");
  return `Approve ${approval.environments.join(", ")} for ${approval.repository} ${run}? `
    + "PwrAgent checks GitHub again first and approves only if nothing changed. "
    + (remote ? "GitHub records the approval for the account signed in on the card's PwrAgent." : "GitHub records the approval as yours.");
}
