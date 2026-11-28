/** A tracker reference selected by the operator. It does not grant tracker or repository authority. */
export type FactoryWorkItem =
  | { provider: "linear"; id: string }
  | { provider: "github"; kind: "issue" | "pull_request"; repositoryId: string; number: number }
  | { provider: "jira"; siteId: string; id: string };

function invalid(): never {
  throw new Error("Select one Factory work item with its tracker and stable identifier.");
}

export function parseFactoryWorkItem(input: { workItem?: unknown; issueId?: unknown }): FactoryWorkItem {
  if (input.issueId !== undefined && input.workItem !== undefined) return invalid();
  const value = input.issueId === undefined ? input.workItem : { provider: "linear", id: input.issueId };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const item = value as Record<string, unknown>;
  switch (item.provider) {
    case "linear":
      if (typeof item.id === "string" && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(item.id) && item.id.length === 36) {
        return { provider: "linear", id: item.id.toLowerCase() };
      }
      break;
    case "github":
      if ((item.kind === "issue" || item.kind === "pull_request") && typeof item.repositoryId === "string"
        && item.repositoryId.length > 0 && item.repositoryId.length <= 256 && !/[^A-Za-z0-9_+/=-]/.test(item.repositoryId)
        && typeof item.number === "number" && Number.isSafeInteger(item.number) && item.number > 0) {
        return { provider: "github", kind: item.kind, repositoryId: item.repositoryId, number: item.number };
      }
      break;
    case "jira":
      if (typeof item.siteId === "string" && item.siteId.length > 0 && item.siteId.length <= 128
        && !/[^A-Za-z0-9_.-]/.test(item.siteId) && typeof item.id === "string"
        && item.id.length > 0 && item.id.length <= 32 && item.id[0] !== "0" && !/[^0-9]/.test(item.id)) {
        return { provider: "jira", siteId: item.siteId, id: item.id };
      }
      break;
  }
  return invalid();
}

export function factoryWorkItemKey(item: FactoryWorkItem): string {
  switch (item.provider) {
    case "linear": return `linear:${item.id}`;
    case "github": return `github:${item.kind}:${item.repositoryId}:${item.number}`;
    case "jira": return `jira:${item.siteId}:${item.id}`;
  }
}
