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
