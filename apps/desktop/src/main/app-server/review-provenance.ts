import type {
  AppServerReviewContext,
  AppServerReviewPullRequest,
  AppServerReviewTarget,
  LinkedDirectorySummary,
  PrSummary,
} from "@pwragent/shared";
import {
  normalizeFullRef,
  type NamedReviewPullRequest,
} from "../../shared/review-command";
import { runGitCommand } from "./git-executable";
import {
  normalizeWorkspacePath,
  prBelongsToWorkspace,
  prMatchesRepository,
  type ReviewGitRunner,
} from "./review-workspace-guard";
import {
  resolveGitHubReposForDirectory,
  type GitHubRepoRef,
} from "../pr-status/git-remote";
import {
  forgeRepositoryName,
  repositoryKey,
  withForgeRepositoryNames,
} from "../pr-status/forge-repository-names";

/**
 * Git reports a detached HEAD as the literal string "HEAD" rather than
 * failing, so it has to be rejected by name.
 */
const DETACHED_HEAD = "HEAD";

function directoryMatchesWorkspace(
  directory: LinkedDirectorySummary,
  workspacePath: string,
): boolean {
  const workspace = normalizeWorkspacePath(workspacePath);
  return (
    normalizeWorkspacePath(directory.worktreePath ?? "") === workspace
    || normalizeWorkspacePath(directory.path) === workspace
  );
}

/**
 * The label the operator picked the project by. Falling back to the workspace's
 * own basename keeps a review that ran outside any linked directory nameable
 * without inventing a label the sidebar never showed.
 */
function resolveProjectLabel(
  directory: LinkedDirectorySummary | undefined,
  workspacePath: string,
): string | undefined {
  const label = directory?.label.trim();
  if (label) {
    return label;
  }
  // Not `normalizeWorkspacePath`: it case-folds a Windows drive-letter path so
  // two paths can be compared, which would label `C:\Users\dev\PwrAgent` as
  // "pwragent". A displayed name keeps the casing the operator gave it.
  return workspacePath
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .split("/")
    .pop()
    || undefined;
}

async function resolveCheckedOutBranch(
  runGit: ReviewGitRunner,
  cwd: string,
): Promise<string | undefined> {
  try {
    const result = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = result.stdout.trim();
    return branch && branch !== DETACHED_HEAD ? branch : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A commit hash Git printed, or nothing at all.
 *
 * `rev-parse` and `merge-base` both answer some failures on stdout rather than
 * by exiting non-zero — an unfetched base branch, a repository with no commits
 * yet. Freezing that text onto the card as a commit would be worse than the
 * absent field the reader already knows how to read, so only a hash is kept.
 *
 * The upper bound is 64, not 40: a repository created with
 * `--object-format=sha256` prints 64-character hashes, and capping at SHA-1's
 * width would leave every review there with no commit at all.
 */
async function resolveCommitSha(
  runGit: ReviewGitRunner,
  cwd: string,
  args: string[],
): Promise<string | undefined> {
  try {
    const result = await runGit(cwd, args);
    const sha = result.stdout.trim();
    return /^[0-9a-f]{7,64}$/i.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

function toReviewPullRequest(pr: PrSummary): AppServerReviewPullRequest {
  return {
    provider: pr.provider,
    org: pr.org,
    repo: pr.repo,
    number: pr.number,
    url: pr.url,
    ...(pr.title?.trim() ? { title: pr.title.trim() } : {}),
    ...(pr.headRefName?.trim() ? { headRefName: pr.headRefName.trim() } : {}),
    ...(pr.baseRefName?.trim() ? { baseRefName: pr.baseRefName.trim() } : {}),
  };
}

/**
 * The checked-out branch is the signal. A branch carrying a pull request is
 * strong evidence that the pull request is what was reviewed; nothing else the
 * thread happens to hold says anything about this diff, so a thread's other
 * pull requests are never candidates.
 *
 * `linkedDirectoryPaths` is thread-local provenance recorded by PR discovery.
 * It is what keeps two of the thread's repositories sharing a branch name —
 * `main`, or a shared `agent/...` convention — from crossing over. Where it is
 * absent (an older row, a peer that predates it) the workspace's own Git
 * remotes narrow the field instead.
 */
async function selectPullRequestForBranch(params: {
  cwd: string;
  branch: string;
  prs: PrSummary[];
  resolveGitHubRepos: (cwd: string) => Promise<GitHubRepoRef[]>;
}): Promise<PrSummary | undefined> {
  const branch = normalizeFullRef(params.branch);
  const onBranch = params.prs.filter(
    (pr) =>
      Boolean(pr.headRefName?.trim())
      && normalizeFullRef(pr.headRefName ?? "") === branch,
  );
  if (onBranch.length === 0) {
    return undefined;
  }

  const scoped = onBranch.filter((pr) => pr.linkedDirectoryPaths?.length);
  let candidates = scoped.filter((pr) => prBelongsToWorkspace(pr, params.cwd));
  if (candidates.length === 0) {
    // Only fall back to the unscoped rows. A PR that named its directories and
    // did not name this one has already answered the question.
    candidates = onBranch.filter((pr) => !pr.linkedDirectoryPaths?.length);
  }
  if (candidates.length === 0) {
    return undefined;
  }

  if (candidates.length > 1) {
    const repositories = await params.resolveGitHubRepos(params.cwd).catch(
      () => [] as GitHubRepoRef[],
    );
    if (repositories.length > 0) {
      const inRepository = candidates.filter((pr) =>
        repositories.some((repo) => prMatchesRepository(pr, repo))
      );
      if (inRepository.length > 0) {
        candidates = inRepository;
      }
    }
  }

  // One branch can carry a closed PR and its reopened successor. The open one
  // is the review's subject; ties break on the newer number so the choice is
  // stable rather than dependent on fetch order.
  const open = candidates.filter((pr) => pr.lifecycleState === "open");
  const ranked = open.length > 0 ? open : candidates;
  return ranked.reduce((best, pr) => (pr.number > best.number ? pr : best));
}

function sameRepositoryName(left: string | undefined, right: string): boolean {
  return left === undefined || left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * The attached pull request a review command named. A bare number that
 * several of the thread's repositories carry resolves the way a branch match
 * does: this workspace's own pull request, then the one in its Git remotes.
 * Still ambiguous, it names nothing rather than picking one. A pull request
 * the thread has not attached is named by its URL, or in the workspace's one
 * repository.
 */
async function resolveNamedPullRequest(params: {
  cwd: string;
  named: NamedReviewPullRequest;
  prs: PrSummary[];
  resolveGitHubRepos: (cwd: string) => Promise<GitHubRepoRef[]>;
}): Promise<AppServerReviewPullRequest | undefined> {
  const { named } = params;
  let candidates = params.prs.filter((pr) =>
    pr.number === named.number
    && sameRepositoryName(named.provider, pr.provider)
    && sameRepositoryName(named.org, pr.org)
    && sameRepositoryName(named.repo, pr.repo)
  );
  if (candidates.length > 1) {
    const inWorkspace = candidates.filter((pr) => prBelongsToWorkspace(pr, params.cwd));
    if (inWorkspace.length > 0) candidates = inWorkspace;
  }
  if (candidates.length > 1) {
    const repositories = await params.resolveGitHubRepos(params.cwd).catch(
      () => [] as GitHubRepoRef[],
    );
    const inRepository = candidates.filter((pr) =>
      repositories.some((repo) => prMatchesRepository(pr, repo))
    );
    if (inRepository.length > 0) candidates = inRepository;
  }
  if (candidates.length === 1) {
    return toReviewPullRequest(candidates[0]);
  }
  if (candidates.length > 0) {
    return undefined;
  }
  if (named.provider && named.org && named.repo && named.url) {
    return {
      provider: named.provider,
      org: named.org,
      repo: named.repo,
      number: named.number,
      url: named.url,
    };
  }
  return await resolveUnattachedPullRequest(params);
}

const PULL_REQUEST_URL_NUMBER = /\/(?:pull|-\/merge_requests)\/[1-9][0-9]*$/;

/**
 * A pull request the thread has not attached, named in the one repository
 * this workspace's work lives in: the repository its attached pull requests
 * share, else its only GitHub remote. A fork beside its upstream could own
 * either number, so more than one candidate names nothing.
 */
async function resolveUnattachedPullRequest(params: {
  cwd: string;
  named: NamedReviewPullRequest;
  prs: PrSummary[];
  resolveGitHubRepos: (cwd: string) => Promise<GitHubRepoRef[]>;
}): Promise<AppServerReviewPullRequest | undefined> {
  const { named } = params;
  const repositories = await params.resolveGitHubRepos(params.cwd).catch(
    () => [] as GitHubRepoRef[],
  );
  const scoped = params.prs.filter((pr) => prBelongsToWorkspace(pr, params.cwd));
  // A row that recorded no directory may belong to any of the thread's
  // repositories, so it speaks for this one only when a remote here matches.
  const workspacePrs = (scoped.length > 0
    ? scoped
    : params.prs.filter((pr) =>
        !pr.linkedDirectoryPaths?.length
        && repositories.some((repo) => prMatchesRepository(pr, repo))
      )
  ).filter((pr) =>
    sameRepositoryName(named.provider, pr.provider)
    && sameRepositoryName(named.org, pr.org)
    && sameRepositoryName(named.repo, pr.repo)
    && PULL_REQUEST_URL_NUMBER.test(pr.url.replace(/\/$/, ""))
  );
  const attachedRepositories = new Map(workspacePrs.map((pr) => [
    `${pr.provider}/${pr.org}/${pr.repo}`.toLowerCase(),
    pr,
  ]));
  if (attachedRepositories.size === 1) {
    const [sibling] = attachedRepositories.values();
    return {
      provider: sibling.provider,
      org: sibling.org,
      repo: sibling.repo,
      number: named.number,
      url: sibling.url.replace(/\/$/, "").replace(/[0-9]+$/, String(named.number)),
    };
  }
  if (attachedRepositories.size > 1) {
    return undefined;
  }
  // A renamed repository's remote can still carry the old name. Match either
  // name, and name the PR the way the forge does, so two remotes spelling the
  // same repository two ways are still one repository.
  const remotes = new Map(repositories
    .filter((remote) => withForgeRepositoryNames([remote]).some((name) =>
      sameRepositoryName(named.provider, name.host)
      && sameRepositoryName(named.org, name.owner)
      && sameRepositoryName(named.repo, name.repo)
    ))
    .map(forgeRepositoryName)
    .map((remote) => [repositoryKey(remote), remote]));
  if (remotes.size !== 1) {
    return undefined;
  }
  const [remote] = remotes.values();
  return {
    provider: remote.host,
    org: remote.owner,
    repo: remote.repo,
    number: named.number,
    url: `https://${remote.host}/${remote.owner}/${remote.repo}/pull/${named.number}`,
  };
}

function samePullRequest(
  left: AppServerReviewPullRequest,
  right: AppServerReviewPullRequest,
): boolean {
  return left.number === right.number
    && left.provider.toLowerCase() === right.provider.toLowerCase()
    && left.org.toLowerCase() === right.org.toLowerCase()
    && left.repo.toLowerCase() === right.repo.toLowerCase();
}

/**
 * Freezes what a review card needs to say what it reviewed. Returns undefined
 * only when there is no workspace to name at all — every other unknown is
 * carried as an absent field, because "we could not check" and "we checked and
 * there was none" have to stay distinguishable on the card.
 */
export async function resolveReviewProvenance(params: {
  cwd?: string;
  executionTarget?: "local" | "remote";
  linkedDirectories?: LinkedDirectorySummary[];
  /** Pull requests the review command named as its targets. */
  namedPullRequests?: NamedReviewPullRequest[];
  prs?: PrSummary[];
  resolveGitHubRepos?: (cwd: string) => Promise<GitHubRepoRef[]>;
  runGit?: ReviewGitRunner;
  target: AppServerReviewTarget;
}): Promise<AppServerReviewContext | undefined> {
  const cwd = params.cwd?.trim();
  if (!cwd) {
    return undefined;
  }

  const directory = (params.linkedDirectories ?? []).find((candidate) =>
    directoryMatchesWorkspace(candidate, cwd)
  );
  const context: AppServerReviewContext = {
    workspacePath: cwd,
  };
  const projectLabel = resolveProjectLabel(directory, cwd);
  if (projectLabel) {
    context.projectLabel = projectLabel;
  }
  if (
    directory?.kind === "worktree"
    && directory.path.trim()
    && normalizeWorkspacePath(directory.path) !== normalizeWorkspacePath(cwd)
  ) {
    context.repositoryPath = directory.path.trim();
  }
  if (params.target.type === "pullRequest") {
    const snapshot = params.target.snapshot;
    if (!snapshot) throw new Error("Missing pull request review snapshot.");
    return {
      ...context,
      gitBranch: snapshot.pullRequest.headRefName,
      baseBranch: snapshot.pullRequest.baseRefName,
      headCommit: snapshot.headCommit,
      baseCommit: snapshot.mergeBaseCommit,
      pullRequest: snapshot.pullRequest,
      pullRequestSnapshot: snapshot,
    };
  }
  if (params.target.type === "baseBranch") {
    context.baseBranch = params.target.branch;
  }

  // A commit target reviews that commit, not the branch that happens to be
  // checked out beside it. Naming the branch would attach the review to work it
  // did not look at, and the pull-request match rests on the same signal.
  if (params.target.type === "commit") {
    return context;
  }

  // A review command that named its pull requests reviewed those, whatever
  // the workspace has checked out.
  const namedPullRequests = params.namedPullRequests ?? [];
  if (namedPullRequests.length > 0) {
    // Only local Git can be read here; a remote workspace's remotes are not.
    const resolveGitHubRepos = params.executionTarget === "remote"
      ? async () => [] as GitHubRepoRef[]
      : params.resolveGitHubRepos ?? resolveGitHubReposForDirectory;
    const matches = await Promise.all(namedPullRequests.map((named) =>
      resolveNamedPullRequest({
        cwd,
        named,
        prs: params.prs ?? [],
        resolveGitHubRepos,
      })
    ));
    const found = matches.filter(
      (match): match is AppServerReviewPullRequest => match !== undefined,
    );
    // Naming some of the reviewed pull requests would read as a review of
    // those alone.
    if (found.length < matches.length) {
      return context;
    }
    // One pull request can be written several ways: `7`, `#7`, its URL.
    const resolved = found.filter((match, index) =>
      found.findIndex((other) => samePullRequest(other, match)) === index
    );
    if (resolved.length > 1) {
      // One branch and one commit cannot describe several diffs, so the card
      // names the pull requests alone.
      return { ...context, pullRequest: resolved[0], pullRequests: resolved };
    }
    const [named] = resolved;
    // Only a pull request with a head branch can be the checked-out one.
    const checkedOut = named.headRefName
      ? await resolveReviewProvenance({ ...params, namedPullRequests: undefined })
      : undefined;
    if (checkedOut?.pullRequest && samePullRequest(checkedOut.pullRequest, named)) {
      return checkedOut;
    }
    // The workspace's HEAD belongs to another branch, and the pull request's
    // cached head may not be the state the reviewer read, so no commit.
    return {
      ...context,
      ...(named.headRefName ? { gitBranch: named.headRefName } : {}),
      ...(named.baseRefName ? { baseBranch: named.baseRefName } : {}),
      pullRequest: named,
    };
  }

  // Local Git is the only workspace inspection available here. A remote
  // workspace keeps whatever branch navigation last observed and stops short of
  // a pull-request claim it cannot verify.
  const runGit = params.runGit ?? runGitCommand;
  const inspectsLocalGit = params.executionTarget !== "remote";
  // One round of Git rather than three serial spawns: a review is waiting on
  // this, and the three questions do not depend on each other's answers.
  const [headCommit, baseCommit, checkedOutBranch] = inspectsLocalGit
    ? await Promise.all([
        resolveCommitSha(runGit, cwd, ["rev-parse", "HEAD"]),
        context.baseBranch
          ? resolveCommitSha(runGit, cwd, [
              "merge-base",
              context.baseBranch,
              "HEAD",
            ])
          : undefined,
        resolveCheckedOutBranch(runGit, cwd),
      ])
    : [undefined, undefined, undefined];
  if (headCommit) {
    context.headCommit = headCommit;
  }
  if (baseCommit) {
    context.baseCommit = baseCommit;
  }

  // Deliberately after the commits: a detached HEAD has no branch and no pull
  // request, but it does have the commit that was reviewed.
  const branch = inspectsLocalGit
    ? checkedOutBranch ?? directory?.gitBranch?.trim()
    : directory?.gitBranch?.trim();
  if (!branch) {
    return context;
  }
  context.gitBranch = branch;

  if (!params.prs) {
    // No pull-request data was fetched for this thread, so nothing was checked.
    return context;
  }

  const pullRequest = await selectPullRequestForBranch({
    branch,
    cwd,
    prs: params.prs,
    resolveGitHubRepos:
      params.resolveGitHubRepos ?? resolveGitHubReposForDirectory,
  });
  context.pullRequest = pullRequest ? toReviewPullRequest(pullRequest) : null;
  return context;
}
