import type { ReviewThreadTodoCiDeploymentRequest } from "@pwragent/shared/contracts/thread-todos";
import type { ForgeRepository } from "../pr-status/forge-tool-contract";
import { parseCiRunUrl, type CiRunUrlOptions } from "../app-server/thread-dependency-ci-runs";

/**
 * Approving a GitHub deployment gate from a CI approval card. See
 * https://docs.github.com/en/rest/actions/workflow-runs#review-pending-deployments-for-a-workflow-run
 *
 * The operator clicked Approve on what the card showed. Between that and the
 * write, the run can be rerun, pushed past, approved by someone else, or
 * moved to another environment. So the owner reads the run and its pending
 * deployments again, immediately before the write, and refuses unless the
 * repository, attempt, head commit and every environment id still match and
 * GitHub says this account may approve each one. Only the environments the
 * card showed are approved, never ones GitHub added since.
 */

/** One GitHub REST request through the owner's forge client. */
export type CiDeploymentGithubRequest = (
  repository: ForgeRepository,
  request: { method?: "GET" | "POST"; path: string; body?: unknown; enterpriseCi: true },
) => Promise<unknown>;

/** A review the owner refused before writing; its message is the card's. */
export class CiDeploymentReviewRefusal extends Error {
  constructor(readonly code: "changed" | "not_allowed" | "invalid", message: string) {
    super(message);
  }
}

/** The fixed comment GitHub records with the approval. */
export const CI_DEPLOYMENT_APPROVAL_COMMENT = "Approved by the operator from PwrAgent.";

function object(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CiDeploymentReviewRefusal("invalid", `GitHub returned an invalid ${what}.`);
  }
  return value as Record<string, unknown>;
}

const sameText = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * Checks the fresh reads against what the operator reviewed. Returns the ids
 * to approve, in the card's order, or throws the refusal the card shows.
 */
export function verifyCiDeploymentReview(
  reviewed: ReviewThreadTodoCiDeploymentRequest,
  runBody: unknown,
  pendingBody: unknown,
): number[] {
  const run = object(runBody, "run");
  if (run.id !== reviewed.runId) throw new CiDeploymentReviewRefusal("invalid", "GitHub returned a different run.");
  const repository = run.repository && typeof run.repository === "object" ? object(run.repository, "repository") : {};
  if (!sameText(repository.full_name, reviewed.repository)) {
    throw new CiDeploymentReviewRefusal("changed", `Run #${reviewed.runId} is no longer in ${reviewed.repository}. Review it on GitHub.`);
  }
  if (run.run_attempt !== reviewed.attempt) {
    throw new CiDeploymentReviewRefusal("changed", `Run #${reviewed.runId} was restarted as attempt ${String(run.run_attempt)} after you reviewed attempt ${reviewed.attempt}. Review it on GitHub.`);
  }
  if (!sameText(run.head_sha, reviewed.headSha)) {
    throw new CiDeploymentReviewRefusal("changed", `Run #${reviewed.runId} now builds a different commit than the ${reviewed.headSha.slice(0, 12)} you reviewed. Review it on GitHub.`);
  }
  if (run.status !== "waiting") {
    throw new CiDeploymentReviewRefusal("changed", `Run #${reviewed.runId} is no longer waiting for review (${typeof run.status === "string" ? run.status : "unknown"}).`);
  }
  if (!Array.isArray(pendingBody)) throw new CiDeploymentReviewRefusal("invalid", "GitHub returned an invalid list of pending deployments.");
  const pending = pendingBody.map((entry) => object(entry, "pending deployment"));
  return reviewed.environments.map((name, index) => {
    const id = reviewed.environmentIds[index];
    const entry = pending.find((candidate) => candidate.environment
      && typeof candidate.environment === "object" && (candidate.environment as Record<string, unknown>).id === id);
    if (id === undefined || !entry) {
      throw new CiDeploymentReviewRefusal("changed", `${name} is no longer waiting for review on run #${reviewed.runId}.`);
    }
    if ((entry.environment as Record<string, unknown>).name !== name) {
      throw new CiDeploymentReviewRefusal("changed", `GitHub now names environment ${id} differently than the ${name} you reviewed. Review it on GitHub.`);
    }
    if (entry.current_user_can_approve !== true) {
      throw new CiDeploymentReviewRefusal("not_allowed", `GitHub says your account cannot approve ${name}. A required reviewer must approve it on GitHub.`);
    }
    return id;
  });
}

/** Re-reads the run and its gates, verifies them, then approves the reviewed environments. */
export async function approveGithubCiDeployment(params: {
  request: CiDeploymentGithubRequest;
  reviewed: ReviewThreadTodoCiDeploymentRequest;
  urls: CiRunUrlOptions;
}): Promise<{ environments: string[] }> {
  const { reviewed } = params;
  if (reviewed.environments.length === 0 || reviewed.environments.length !== reviewed.environmentIds.length
    || new Set(reviewed.environmentIds).size !== reviewed.environmentIds.length) {
    throw new CiDeploymentReviewRefusal("invalid", "Choose the environments to approve.");
  }
  // Parsed here, on the owner, so a host the operator removed is not written to.
  const ref = parseCiRunUrl(reviewed.url, params.urls);
  if (!ref || ref.repository.provider !== "github" || ref.runId !== reviewed.runId
    || !sameText(`${ref.repository.owner}/${ref.repository.repo}`, reviewed.repository)) {
    throw new CiDeploymentReviewRefusal("invalid", "This card does not name a GitHub Actions run PwrAgent may review.");
  }
  const base = `repos/${encodeURIComponent(ref.repository.owner)}/${encodeURIComponent(ref.repository.repo)}/actions/runs/${ref.runId}`;
  // Gates first, then the run. Pending deployments name no attempt or
  // commit, and a rerun keeps the environment ids, so the run read last is
  // what proves the gates still belong to the attempt the operator reviewed.
  // Attempts only increase, so a match there cannot hide a rerun in between.
  const pending = await params.request(ref.repository, { path: `${base}/pending_deployments`, enterpriseCi: true });
  const run = await params.request(ref.repository, { path: base, enterpriseCi: true });
  const environmentIds = verifyCiDeploymentReview(reviewed, run, pending);
  await params.request(ref.repository, {
    method: "POST",
    enterpriseCi: true,
    path: `${base}/pending_deployments`,
    body: { environment_ids: environmentIds, state: "approved", comment: CI_DEPLOYMENT_APPROVAL_COMMENT },
  });
  return { environments: [...reviewed.environments] };
}
