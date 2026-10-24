# First-party forge read tools

Design and API contract, 2026-10-11. These tools expose the existing PR status
registry and forge authentication to Codex dynamic tools and ACP MCP clients.
No Codex GitHub connector is required.

## Contracts

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

All tools accept an optional thread/backend/instance target. Repository
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
| PR diffs, changed files, review threads, issues and repository search | Not implemented by this read-tool family |
| CI reruns, PR mutations, reviews and comments | Not implemented by this read-tool family |

The PwrAgent-specific capabilities remain cache freshness, explicit refresh
costs, thread/repository authorization, owner routing and Auto-fix guidance.
Read access remains independent of review automation. No mutation or review
capability was enabled to close the read-side gaps.
