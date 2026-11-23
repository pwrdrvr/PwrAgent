/** gh stack v0.3.0's on-disk fields. Branches are ordered from trunk outward. */
export interface GhStackPullRequest {
  number: number;
  id?: string;
  url?: string;
  merged?: boolean;
  mergedHead?: string;
}

export interface GhStackBranch {
  branch: string;
  head?: string;
  base?: string;
  pullRequest?: GhStackPullRequest;
}

export interface GhStack {
  id?: string;
  number?: number;
  trunk: GhStackBranch;
  branches: GhStackBranch[];
}

export interface GhStackCatalog {
  schemaVersion: number;
  repository: string;
  stacks: GhStack[];
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const optionalString = (value: unknown) => value === undefined || typeof value === "string";
const optionalNumber = (value: unknown) => value === undefined || Number.isSafeInteger(value);

function isBranch(value: unknown): value is GhStackBranch {
  if (!object(value) || typeof value.branch !== "string" || !value.branch ||
      !optionalString(value.head) || !optionalString(value.base)) return false;
  const pr = value.pullRequest;
  return pr === undefined || (object(pr) && Number.isSafeInteger(pr.number) &&
    optionalString(pr.id) && optionalString(pr.url) && optionalString(pr.mergedHead) &&
    (pr.merged === undefined || typeof pr.merged === "boolean"));
}

function isStack(value: unknown): value is GhStack {
  return object(value) && optionalString(value.id) && optionalNumber(value.number) &&
    isBranch(value.trunk) && Array.isArray(value.branches) && value.branches.every(isBranch);
}

export function parseGhStackCatalog(source: string): GhStackCatalog {
  const value: unknown = JSON.parse(source);
  if (!object(value) || typeof value.schemaVersion !== "number") {
    throw new Error("Invalid gh stack catalog");
  }
  const valid = typeof value.repository === "string" && Array.isArray(value.stacks) && value.stacks.every(isStack);
  if (valid) return value as unknown as GhStackCatalog;
  if (value.schemaVersion !== 1) return { schemaVersion: value.schemaVersion, repository: "", stacks: [] };
  // Go encodes a nil slice as null.
  if (typeof value.repository === "string" && value.stacks === null) {
    return { ...value, schemaVersion: 1, repository: value.repository, stacks: [] };
  }
  throw new Error("Invalid gh stack v1 catalog");
}

export function requireWritableCatalog(catalog: GhStackCatalog): void {
  if (catalog.schemaVersion !== 1) {
    throw new Error(`gh stack catalog version ${catalog.schemaVersion} is read-only`);
  }
}
