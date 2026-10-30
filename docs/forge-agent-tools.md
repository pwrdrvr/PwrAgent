# First-party forge tools

Design and API contract, 2026-10-11, extended 2026-10-26 with the pull
request, merge request and issue tools for GitHub and GitLab. These tools expose the existing PR status registry
and forge authentication to Codex dynamic tools and ACP MCP clients. No Codex
GitHub connector or GitHub App is required.

All of them live in the `forge` agent-tool catalog in the `pwragent`
namespace. Before 2026-10-26 the read tools were part of the
`thread_inspection` catalog, and Codex dispatch did not route them: Codex
threads could discover them, but every call failed with "No PwrAgent handler is
registered for this dynamic tool call". Codex dispatch now routes the whole
catalog.

## Operator policy

`[git.agent_tools]` in the profile's `config.toml`, shown in **Settings → Git →
Agent forge tools**:

| Key | Values | Default | Governs |
| --- | --- | --- | --- |
| `enabled` | `true`, `false` | `true` | The whole family, including CI reads |
| `read` | `allow`, `off` | `allow` | Every read tool below |
| `pull_requests` | `allow`, `auto`, `ask`, `off` | `auto` | `create_pull_request`, `update_pull_request` |
| `comments` | same | `auto` | `add_issue_comment`, `reply_to_review_comment`, `resolve_review_thread`, a `COMMENT` review |
| `issues` | same | `auto` | `create_issue`, `update_issue` |
| `ci` | same | `auto` | `rerun_failed_ci_jobs` |
| `approve_merge` | same | `ask` | `merge_pull_request`, an `APPROVE` or `REQUEST_CHANGES` review |

- `allow` runs without asking. `auto` asks unless the turn has Full Access,
  the same rule as an MCP connection's Auto tool approval. `ask` always asks.
  `off` removes the tools.
- A group that is off, or the family switched off, is not advertised to new
  turns. The main process also checks the policy on every call, so a turn that
  still holds an older schema gets `tools_disabled` naming the setting.
- The prompt is the shipped MCP approval card (a host-owned
  `mcpServer/elicitation/request` with `pwragent_approval_kind:
  "mcp_tool_call"`), so desktop and messaging draw it the same way. Comments
  and issues also offer a conversation grant, kept in memory until PwrAgent
  restarts or that group's level changes. Opening, editing, approving and
  merging, and rerunning CI jobs are granted one call at a time.
- Automations cannot answer a prompt. An `auto` or `ask` write in an
  automation fails with `approval_required` unless the automation runs in
  Full Access and the level is `auto`.
- A peer's federated read of this instance's thread follows this instance's
  `enabled` and `read` settings.
- Messaging-started turns need **Agent: inspect threads**
  (`tools.thread_inspection`) for reads and **Agent: change GitHub and GitLab**
  (`tools.forge_write`) for writes. `FORGE_AGENT_WRITE_TOOL_GROUPS` in
  `@pwragent/shared` lists every write, and both gates read it.

## Pull request, merge request and issue tools

One contract for GitHub, GitHub Enterprise and GitLab. Tool names say "pull
request" for both; on GitLab they act on merge requests. Each acts in the
calling thread's own repository. `repository` chooses among the thread's linked
remotes and attached PR/MR repositories, and a thread with more than one must
name it. None of these tools accepts a thread or Federation target.

Before a write asks for approval, PwrAgent resolves its repository, so the card
names it (`connector_name`) and says GitHub or GitLab, pull request or merge
request. A call with no single target fails before any prompt.

Reads (`read` group):

- `get_pull_request`: the PR/MR read back, with its body. Without `number` or
  `url`, the thread's attached PR/MR or the one whose head is the thread's
  branch.
- `list_pull_requests`, `list_pull_request_files` (optional bounded patches),
  `list_pull_request_reviews`, `list_issue_comments`: bounded pages.
- `get_pull_request_diff`: the unified diff, optionally only files under
  `path`, paged from the start with `startChar` and a SHA-256 `diffSnapshot`.
  A push between pages fails with `diff_changed`.
- `list_pull_request_review_threads`: review threads with resolved state and
  up to 20 comments each. Returns the `reviewThreadId` and `commentId` values
  the write tools take.
- `get_issue`, `search_issues`: search is scoped to the repository, and
  refuses `repo:`, `org:`, `user:` and `owner:` in the query.

Writes:

- `create_pull_request`: head defaults to the thread's branch and base to the
  repository's default branch. Draft, labels and reviewers are optional. The
  new PR/MR is attached to the calling thread (`attachedToThread`).
- `update_pull_request`: title, body, base, open or closed, draft or ready,
  labels and reviewers.
- `add_issue_comment`, `reply_to_review_comment` (by `reviewThreadId` or a
  `commentId`), `submit_pull_request_review` (with inline comments),
  `resolve_review_thread`.
- `create_issue`, `update_issue`.
- `merge_pull_request`: requires `expectedHeadSha`, sent as the merge `sha`,
  so a later push fails with `head_changed`. The method defaults to Settings →
  Git → Default merge method. The branch is not deleted.

Attachments (`create_pull_request`, `update_pull_request`, `add_issue_comment`,
`create_issue`, `update_issue`) accept only png, jpg, gif, webp, mp4, mov and
webm files up to 25 MB, under the thread's linked directories or the temp
folder, and never from PwrAgent's private storage roots. A body that
references an attachment by its exact path gets the uploaded link in place;
others are appended. An edit with attachments needs the full new body.

Bodies, comments and review text are returned as untrusted data. A refused
write returns the forge's own reason, redacted and capped at 600 characters,
and does not start a provider cooldown.

### GitHub

- Requests use the `gh` sign-in for the repository's host, through the same
  admission as CI reads: per-host cooldowns, three requests at a time, and the
  shared PR request budget. Review threads, draft changes and thread
  resolution use GraphQL.
- A review thread's node is checked to belong to this repository before it is
  replied to or resolved.
- Attachments upload through `gh --attach` (gh 2.99 or later), because GitHub
  has no public upload API. If some uploads fail, gh still creates the item
  and the result carries `attachmentWarning`.
- `search_issues` takes GitHub search syntax; the tool adds the `repo:`
  qualifier.

### GitLab

- Reads and writes go through `glab api` with the existing GitLab transport's
  concurrency limit and request budget. A write's JSON body travels in a 0600
  temp file passed with `--input`, never in process arguments. Writes are not
  coalesced.
- Attachments go to the project's uploads API. `glab api` cannot send
  multipart requests, so this one request reads the host's token (`glab config
  get token`, else `glab auth status --show-token`) and posts directly over
  HTTPS. The token is cached in memory for five minutes and never logged.
- GitLab numbers issues and merge requests separately. `list_issue_comments`
  and `add_issue_comment` take `kind: "pr"` for a merge request; the default is
  an issue. `get_issue` reads issues only.
- Draft state is the `Draft:` title prefix. Labels change through
  `add_labels`/`remove_labels`, and reviewers are looked up by username.
- `list_pull_request_reviews` returns the approvals. Review threads are the
  resolvable discussions; `after` is a page number. `resolve_review_thread`
  also needs `number`.
- Inline review comments attach to the merge request's current diff refs.
  Line ranges are sent as their last line. `APPROVE` posts an approval.
  `REQUEST_CHANGES` is refused: GitLab's API has no such review.
- `get_pull_request_diff` reads `raw_diffs`, falling back on older servers to
  paged `/diffs` for at most 1,000 files (`filesTruncated` says so).
- `merge_pull_request` supports `merge` and `squash`; the project's merge
  method applies. `rebase` is refused.
- `search_issues` matches words in titles and descriptions; GitHub qualifiers
  do not apply. GitLab's `closed` state excludes merged merge requests.
- A merge request from a fork cannot be opened here; pass a source branch.

## CI reruns

`rerun_failed_ci_jobs` requests a rerun using a `runId` from `list_ci_runs`
or `get_ci_run`. It acts in the calling thread's repository, following the
same repository resolution, provider settings, write approval and messaging
authorization as the other writes. It accepts no thread or Federation target.
**Settings → Git → Agent forge tools → CI reruns** controls access separately
from read access; its default is Auto.

- GitHub and GitHub Enterprise use
  [`POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs`](https://docs.github.com/en/rest/actions/workflow-runs#re-run-failed-jobs-from-a-workflow-run).
  GitHub reruns failed jobs and their dependent jobs. Authentication needs
  Actions write permission.
- GitLab uses
  [`POST /projects/:id/pipelines/:pipeline_id/retry`](https://docs.gitlab.com/api/pipelines/#retry-jobs-in-a-pipeline).
  This retries failed **and canceled** jobs, and has no effect if there are
  none. The tool description and approval card name this broader behavior.

Success returns `requested: true`, `runId`, the repository, provider request
count, source URL and a provider-specific `scope`. It means the provider
accepted the request, not that any job completed or passed. Provider refusals
are returned through the existing bounded, redacted error path. A timeout or
disconnect may leave the outcome unknown; inspect the run before requesting
another retry. This tool does not poll, start a repair turn, or add persistence.

## CI read contracts

- `get_forge_status`: cache-only by default, with per-observation fetched time,
  age, freshness, source and provider enablement. `refresh: true` explicitly
  spends the existing PR request budget through the provider router. An
  explicit PR/MR URL or repository/branch narrows the thread's scope.
- `list_ci_runs`: one bounded page of GitHub Actions runs or GitLab pipelines,
  optionally filtered by branch and head SHA.
- `get_ci_run`: run/pipeline metadata and one page of jobs, including failed
  steps and job URLs. Pagination applies to jobs, not run metadata.
- `get_ci_job`: job metadata, failed steps and source URL.
- `get_commit_checks`: individual GitHub check runs plus latest commit status
  contexts, or GitLab's latest commit statuses (including external CI). Requires
  a full `headSha`, obtained from PR/MR status or a run, so the two GitHub reads
  cannot accidentally describe different branch heads. `page`/`perPage` apply
  independently to checks and status contexts. Both next-page hints and a
  combined `nextPage` are returned. These are observations, not required-check
  policy or an overall passing/merge decision. GitLab accepts an optional
  `branch` ref filter; omit it only when the provider's default ref is intended.
- `list_ci_artifacts`: names, sizes, expiry and source links for one workflow
  run/pipeline. GitHub pages artifacts; GitLab pages jobs and flattens their
  artifact metadata, including report artifacts. `paginationUnit` distinguishes
  those contracts. GitLab returns at most 100 artifact records per call and
  explicitly reports truncation. Reduce `perPage` or open the source job URL
  when truncated. Metadata does not guarantee that an artifact is downloadable.
- `read_ci_job_log`: one job's bounded tail and heuristic failure excerpts;
  every log is explicitly untrusted. Logs are defensively redacted and never
  interpreted as instructions. A failed retrieval is an error, never success.
  Follow the returned `log.next` fields (`beforeChar`, `logSnapshot`) to read
  earlier pages. Offsets count UTF-16 characters after redaction, with an
  exclusive end. Pages can split lines. A SHA-256 digest of the redacted text
  prevents mixing pages when a job appends or replaces output: restart without
  the cursor on `log_changed`. Each page downloads and redacts the source again.

The CI read tools accept an optional thread/backend/instance target. Repository
identities contain the product (`provider`), actual host (`host`), namespace
(`owner`, including GitLab subgroups), and repository (`repo`). Explicit
repositories must belong to the target thread's linked remotes or attached
PR/MR base repositories. Ambiguous selection fails with candidates. Remote
threads execute on their owning instance under `thread_detail` authorization;
local credentials are never used for a remote thread.

The shared thread-inspection catalog advertises these contracts in the unified
`pwragent` namespace. Execution rechecks provider settings even for cached tool
handles. Disabled providers remain identifiable in cache results, but perform
no network access. No review mutation is added. Enabling these read tools does
not start reviews, attach PRs, create subscriptions, change repository settings,
post comments, or create repair turns. Existing explicit `start_review` and
Auto-fix controls remain separate. Operators can turn off the thread’s **Auto-fix PR** choice or disable
**Settings → Git → Pull request automation → Allow Auto-fix PR** globally
without losing read access; existing review tools still require an
explicit operator request. This implementation does not install a GitHub App
or enable third-party automatic review services.

## Boundaries and costs

PR refresh uses the existing provider path and request admission. Read-only
observations do not publish transitions or persist new cache entries: the
existing scheduler remains the sole owner of automatic status publication.
No background polling timers or SQLite writes are added (0 MB/day of new SQLite writes).
CI reads use bounded pages, cancellation, concurrency admission and cooldowns.
GitHub uses the existing CLI credential export with direct HTTPS REST calls;
GitLab reuses the existing authenticated glab API transport. Secrets and raw
transport error output are not returned. Source links contain no credentials.
Logs can still contain application-specific secrets that pattern redaction
cannot recognize; callers must treat the returned content as sensitive data.

GitHub Enterprise CI uses `/api/v3` and host-specific CLI authentication.
The pre-existing GitHub PR status client supports github.com only; Enterprise
PR refresh returns an explicit unsupported error. GitLab custom hosts and
nested namespaces use explicit identities or attached MR URL evidence.
Workflow dispatch, cancellation, reruns, artifact downloads and reviews are
outside this read-only contract.

## Provider references

Official API references inspected 2026-10-11:

- [GitHub workflow runs](https://docs.github.com/en/rest/actions/workflow-runs)
- [GitHub workflow jobs and temporary log redirects](https://docs.github.com/en/rest/actions/workflow-jobs)
- [GitHub REST pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)
- [GitHub check runs](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)
- [GitHub combined commit status contexts](https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference)
- [GitHub workflow artifact metadata](https://docs.github.com/en/rest/actions/artifacts#list-workflow-run-artifacts)
- [GitLab pipelines](https://docs.gitlab.com/api/pipelines/)
- [GitLab jobs and traces](https://docs.gitlab.com/api/jobs/)
- [GitLab commit statuses](https://docs.gitlab.com/api/commits/#list-commit-statuses)

The GitHub client pins API version `2022-11-28` for compatibility with existing
Enterprise deployments; the read contracts used here are also documented by
the current `2026-03-10` reference.

GitHub job log downloads redirect to a short-lived URL. The redirected request
must not carry authorization. GitLab project paths are encoded as one project
identifier. Lists are paged, with no implicit drain of all pages.

## Validation and current limits

Validation uses invented API fixtures and injected transports, including normal
MCP/native invocation, provider failures, disabled handles, host routing, log
redaction, cache/refresh provenance and federated owner authorization. No live
GitHub/GitLab credentials, PR mutations, CI mutations or external reviews are
used during validation.

Pages default to 20 items and are capped at 100. `nextPage` is conservative on
a full page and may lead to an empty terminal page. Failure summaries cover
only returned jobs/retained log text. Logs default to 12,000 retained characters
(maximum 50,000). Log downloads are capped at 16 MiB, while JSON metadata is
capped at 2 MiB. Larger responses fail with an actionable error. No disk cache,
unbounded download or automatic page-draining is introduced. CI calls report
their authenticated provider request count; redirects
can add a credential-free log download. Cache reads do not probe authentication
or retain prior refresh errors, and say so in their result.

Cancellation stops new work and aborts direct HTTP/glab CI requests. Federation
cancellation drops local demand; the owner's propagated deadline bounds its CI
work. The existing GraphQL PR provider's already-running retries cannot be
aborted by these tools. Custom-host GitLab branch discovery still needs the
existing host convention; use an explicit MR URL for other hosts. Check output
is untrusted and redacted, with each text field capped at 2,000 characters.
GitHub's check-run endpoint only covers the latest 1,000 check suites. Neither
provider's page can prove the absence of required checks. No check annotations,
artifact downloads, workflow definitions or review mutations are added.

## Comparison with the Codex GitHub connector

Compared against the connector's available tool definitions on 2026-10-11,
without invoking it or requesting repository access. This is capability
comparison evidence, not a live interoperability test or a promise about every
Codex installation. The original five-tool implementation was based on provider
API documentation; the comparison below motivated the two additional tools and
log pagination.

| Connector capability | PwrAgent coverage |
| --- | --- |
| `fetch_commit_workflow_runs` | `list_ci_runs`, with branch/SHA filters and GitLab pipelines |
| `fetch_workflow_run_jobs`, `fetch_workflow_job_steps` | `get_ci_run`, `get_ci_job` |
| `fetch_workflow_job_logs` | `read_ci_job_log`, bounded redacted pages with snapshot checks |
| `get_commit_combined_status` | `get_commit_checks`, plus check runs and GitLab commit statuses |
| `fetch_workflow_run_artifacts` | `list_ci_artifacts`, including GitLab job artifact metadata |
| `download_workflow_artifact` | Not implemented |
| PR info and body (`fetch_pr`, `get_pr_info`) | `get_pull_request`, also for GitLab merge requests |
| PR diffs and changed files | `get_pull_request_diff`, `list_pull_request_files` |
| PR comments, reviews and review threads | `list_issue_comments`, `list_pull_request_reviews`, `list_pull_request_review_threads` |
| Issues and issue search | `get_issue`, `list_issue_comments`, `search_issues` |
| `create_pull_request`, PR edits, labels | `create_pull_request`, `update_pull_request`, with `gh --attach` attachments |
| Comments, review replies and reviews | `add_issue_comment`, `reply_to_review_comment`, `submit_pull_request_review`, `resolve_review_thread` |
| Merge | `merge_pull_request`, with a required head SHA |
| Repository-wide search, file and commit fetch, branch and commit creation | Not implemented. Threads read and commit through their local checkout |
| CI reruns, artifact download | Not implemented |

The PwrAgent-specific capabilities remain cache freshness, explicit refresh
costs, thread/repository authorization, owner routing, Auto-fix guidance, and
the operator policy above. Read access remains independent of review
automation: none of these tools starts a review or an Auto-fix repair turn.
