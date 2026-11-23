import { ForgeReadError, type ForgeRepository } from "../pr-status/forge-tool-contract";

export type GithubStackPull = {
  state?: string;
  number?: number;
  merged?: boolean;
  merged_at?: string | null;
  closed_at?: string | null;
  created_at?: string;
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null };
  base?: { ref?: string; sha?: string; repo?: { default_branch?: string } | null };
};

export type GithubStackGraphql = (query: string, variables: { owner: string; repo: string; number: number }) => Promise<unknown>;
type Get = (route: string) => Promise<unknown>;
type BaseWindow = { branch: string; since: number; until: number };
type StackParent = { number: number; branch: string; merged: boolean };

const HISTORY_LIMIT = 16;
const BASE_LIMIT = 4;
const BRANCH_PR_LIMIT = 20;
const HISTORY_QUERY = `query PwrAgentStackHistory($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){pullRequest(number:$number){
    baseRefName headRefOid timelineItems(last:${HISTORY_LIMIT},itemTypes:[BASE_REF_CHANGED_EVENT,AUTOMATIC_BASE_CHANGE_SUCCEEDED_EVENT]){
      pageInfo{hasPreviousPage}
      nodes{... on BaseRefChangedEvent{createdAt previousRefName currentRefName}
        ... on AutomaticBaseChangeSucceededEvent{createdAt previousRefName:oldBase currentRefName:newBase}}
    }
  }}
}`;

const time = (value: string | null | undefined): number => Date.parse(value ?? "");
const isSha = (value: string | undefined): value is string => Boolean(value && /^[a-f0-9]{40}$/i.test(value));

function incomplete(number: number): ForgeReadError {
  return new ForgeReadError("stack_parent_open", `Could not verify the historical base of pull request #${number}. Confirm its lower layers and retry once GitHub can provide the stack evidence.`);
}

async function formerBases(repository: ForgeRepository, child: GithubStackPull, number: number, get: Get, graphql: GithubStackGraphql): Promise<BaseWindow[]> {
  const created = time(child.created_at);
  if (!Number.isFinite(created) || !isSha(child.head?.sha)) throw incomplete(number);
  let response: unknown;
  try {
    response = await graphql(HISTORY_QUERY, { owner: repository.owner, repo: repository.repo, number });
  } catch (error) {
    // Older GHES schemas may lack the filtered connection or automatic events.
    // REST can confirm there were no retargets, but does not supply old/new refs.
    if (repository.host.toLowerCase() === "github.com" || !(error instanceof Error)
      || !/cannot query field|doesn't exist on type|itemtypes.*invalid value|invalid value for enum|unknown (?:argument|field|type)|does not exist in.*enum/i.test(error.message)) throw error;
    const events = await get(`/issues/${number}/timeline?per_page=100`) as Array<{ event?: string }>;
    if (!Array.isArray(events) || events.length >= 100 || events.some((entry) =>
      !entry?.event || entry.event === "base_ref_changed" || entry.event === "automatic_base_change_succeeded")) throw incomplete(number);
    return [];
  }
  const current = (response as { repository?: { pullRequest?: {
    baseRefName?: string; headRefOid?: string;
    timelineItems?: { pageInfo?: { hasPreviousPage?: boolean }; nodes?: Array<{
      previousRefName?: string; currentRefName?: string; createdAt?: string;
    } | null> };
  } } })?.repository?.pullRequest;
  const timeline = current?.timelineItems;
  if (current?.baseRefName !== child.base?.ref || current?.headRefOid !== child.head?.sha
    || timeline?.pageInfo?.hasPreviousPage !== false || !Array.isArray(timeline.nodes)
    || timeline.nodes.length > HISTORY_LIMIT) throw incomplete(number);
  let branch = child.base?.ref;
  let until = Number.POSITIVE_INFINITY;
  const windows: BaseWindow[] = [];
  let last: { from: string; to: string; at: number } | undefined;
  for (const node of [...timeline.nodes].reverse()) {
    const at = time(node?.createdAt);
    if (last && last.from === node?.previousRefName && last.to === node.currentRefName && last.at === at) continue;
    if (!node?.previousRefName || !node.currentRefName || node.currentRefName !== branch || at < created || at > until || !Number.isFinite(at)) {
      throw incomplete(number);
    }
    // GitHub can record both the automatic change and its base ref change.
    last = { from: node.previousRefName, to: node.currentRefName, at };
    if (windows.length) windows[windows.length - 1]!.since = at;
    windows.push({ branch: node.previousRefName, since: created, until: at });
    branch = node.previousRefName;
    until = at;
  }
  return windows;
}

/** GitHub supplies historical ref names, not parent identities. Bind a ref to
 * an overlapping same-repository PR and verify immutable commit ancestry
 * before calling it a dependency. An unresolved plausible parent holds the
 * merge without attaching that parent's identity to the child. */
export async function readGithubStackParents(input: {
  repository: ForgeRepository; number: number; child: GithubStackPull; get: Get; graphql: GithubStackGraphql;
}): Promise<{ parents: StackParent[]; incomplete: boolean }> {
  const { repository, number, child, get, graphql } = input;
  const base = child.base?.ref;
  const trunk = child.base?.repo?.default_branch;
  if (!base || !trunk) throw incomplete(number);
  const history = await formerBases(repository, child, number, get, graphql);
  const active = base !== trunk ? [{
    branch: base, since: history[0]?.until ?? time(child.created_at), until: Number.POSITIVE_INFINITY,
  }] : [];
  const windows = [...active, ...history].filter(({ branch }) => branch !== trunk);
  const sources = new Set(windows.map(({ branch }) => branch));
  if (sources.size > BASE_LIMIT) throw incomplete(number);
  const parents = new Map<number, StackParent>();
  let unresolved = false;
  const repo = `${repository.owner}/${repository.repo}`.toLowerCase();
  for (const branch of sources) {
    const query = new URLSearchParams({ state: "all", head: `${repository.owner}:${branch}`, per_page: String(BRANCH_PR_LIMIT) });
    const rows = await get(`/pulls?${query}`) as GithubStackPull[];
    if (!Array.isArray(rows) || rows.length >= BRANCH_PR_LIMIT) {
      unresolved = true;
      continue;
    }
    const candidates = rows.filter((pr) => {
      if (!pr?.number || !Number.isSafeInteger(pr.number) || pr.number < 1 || pr.number === number
        || pr.head?.ref !== branch || pr.head.repo?.full_name?.toLowerCase() !== repo) return false;
      const opened = time(pr.created_at);
      const ended = time(pr.merged_at ?? (pr.state === "closed" ? pr.closed_at : undefined));
      return windows.some((window) => window.branch === branch
        && !(opened > window.until || ended < window.since));
    });
    if (candidates.length > 1) {
      // Two overlapping PRs can use the same branch, even at the same SHA.
      if (branch === base || candidates.some((candidate) => !candidate.merged_at)) unresolved = true;
      continue;
    }
    const parent = candidates[0];
    if (!parent) continue;
    const merged = Boolean(parent.merged_at);
    if (merged && branch !== base) continue;
    const ancestor = parent.head?.sha;
    const descendant = branch === base ? child.base?.sha : child.head?.sha;
    if (!isSha(ancestor) || !isSha(descendant) || !Number.isFinite(time(parent.created_at))) {
      unresolved = true;
      continue;
    }
    if (ancestor !== descendant) {
      try {
        const comparison = await get(`/compare/${ancestor}...${descendant}?per_page=1`) as { merge_base_commit?: { sha?: string } };
        if (comparison?.merge_base_commit?.sha !== ancestor) {
          unresolved = true;
          continue;
        }
      } catch (error) {
        if (!(error instanceof ForgeReadError) || error.code !== "not_found") throw error;
        unresolved = true;
        continue;
      }
    }
    parents.set(parent.number!, { number: parent.number!, branch, merged });
  }
  return { parents: [...parents.values()], incomplete: unresolved };
}

export function githubStackBlock(
  number: number, base: string, evidence: Awaited<ReturnType<typeof readGithubStackParents>>,
): ForgeReadError | undefined {
  const parent = evidence.parents.find((parent) => parent.branch === base || !parent.merged);
  if (parent) {
    return new ForgeReadError("stack_parent_open", `Pull request #${number} depends on #${parent.number} (${parent.branch}). Wait for lower layers to merge and target trunk before merging.`);
  }
  return evidence.incomplete ? incomplete(number) : undefined;
}
