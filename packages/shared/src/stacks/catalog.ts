export type GhStackPullRequest = {
  number: number;
  id?: string;
  url?: string;
  merged?: boolean;
  mergedHead?: string;
};

export type GhStackBranch = {
  branch: string;
  head?: string;
  base?: string;
  pullRequest?: GhStackPullRequest;
};

export type GhStack = {
  id?: string;
  number?: number;
  trunk: GhStackBranch;
  branches: GhStackBranch[];
};

export type GhStackCatalog = {
  schemaVersion: 1;
  repository: string;
  stacks: GhStack[];
};

export type GhStackCatalogRead =
  | { status: "ok"; catalog: GhStackCatalog }
  | { status: "catalog_schema_unknown"; schemaVersion: number }
  | { status: "catalog_invalid" };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function parseBranch(value: unknown): GhStackBranch | undefined {
  const fields = record(value);
  const branch = optionalString(fields?.branch);
  if (!fields || !branch) return undefined;
  const pr = record(fields.pullRequest);
  const number = positiveInteger(pr?.number);
  if (fields.pullRequest != null && !number) return undefined;
  return {
    branch,
    head: optionalString(fields.head),
    base: optionalString(fields.base),
    ...(pr && number ? { pullRequest: {
      number, id: optionalString(pr.id), url: optionalString(pr.url),
      merged: pr.merged === true, mergedHead: optionalString(pr.mergedHead),
    } } : {}),
  };
}

/** Decode gh stack v1 without requiring its omitempty fields or interpreting later schemas. */
export function parseGhStackCatalog(raw: string): GhStackCatalogRead {
  let data: Record<string, unknown> | undefined;
  try {
    data = record(JSON.parse(raw));
  } catch {
    return { status: "catalog_invalid" };
  }
  if (!data || typeof data.schemaVersion !== "number" || !Number.isSafeInteger(data.schemaVersion)) {
    return { status: "catalog_invalid" };
  }
  if (data.schemaVersion !== 1) return { status: "catalog_schema_unknown", schemaVersion: data.schemaVersion };
  if (!Array.isArray(data.stacks) && data.stacks !== null) return { status: "catalog_invalid" };
  const stacks: GhStack[] = [];
  for (const value of data.stacks ?? []) {
    const fields = record(value);
    const trunk = parseBranch(fields?.trunk);
    if (!trunk || !Array.isArray(fields?.branches)) return { status: "catalog_invalid" };
    const branches = [];
    const seen = new Set([trunk.branch]);
    for (const entry of fields.branches) {
      const branch = parseBranch(entry);
      if (!branch || seen.has(branch.branch)) return { status: "catalog_invalid" };
      seen.add(branch.branch);
      branches.push(branch);
    }
    stacks.push({ id: optionalString(fields.id), number: positiveInteger(fields.number), trunk, branches });
  }
  return { status: "ok", catalog: { schemaVersion: 1, repository: optionalString(data.repository) ?? "", stacks } };
}
