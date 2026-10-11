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
- `read_ci_job_log`: one job's bounded tail and heuristic failure excerpts;
  every log is explicitly untrusted. Logs are defensively redacted and never
  interpreted as instructions. A failed retrieval is an error, never success.

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
- [GitLab pipelines](https://docs.gitlab.com/api/pipelines/)
- [GitLab jobs and traces](https://docs.gitlab.com/api/jobs/)

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
(maximum 50,000); provider responses exceeding 2 MiB fail with an actionable
error. CI calls report their authenticated provider request count; redirects
can add a credential-free log download. Cache reads do not probe authentication
or retain prior refresh errors, and say so in their result.

Cancellation stops new work and aborts direct HTTP/glab CI requests. Federation
cancellation drops local demand; the owner's propagated deadline bounds its CI
work. The existing GraphQL PR provider's already-running retries cannot be
aborted by these tools. Custom-host GitLab branch discovery still needs the
existing host convention; use an explicit MR URL for other hosts. No individual
non-CI status-context list, artifacts or workflow definitions are added.
