import { randomUUID } from "node:crypto";
import type { FederationRemoteTarget, ManageThreadMergeHoldsRequest, ManageThreadMergeHoldsResponse, ThreadMergeHold } from "@pwragent/shared";
import type { FederatedThreadTargetRuntime } from "../federation/federated-thread-target-service";
import { parsePullRequestReferenceUrl } from "../pr-status/forge-reference";

function textField(value: unknown, field: string, max: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${field} must be nonempty text of at most ${max} characters.`);
  }
}

export function validateMergeHoldRequest(request: ManageThreadMergeHoldsRequest): void {
  if (!request || !["create", "list", "active", "resolve", "cancel"].includes(request.action)) throw new Error("Unknown merge hold action.");
  if (request.federationTarget !== undefined) {
    if (!request.federationTarget || !["local", "remote"].includes(request.federationTarget.scope)) throw new Error("federationTarget must identify the waiting thread's owner.");
    if (request.federationTarget.scope === "remote") textField(request.federationTarget.instanceId, "federationTarget.instanceId", 200);
  }
  if (request.includeDependents !== undefined && typeof request.includeDependents !== "boolean") throw new Error("includeDependents must be a boolean.");
  if (request.pullRequest !== undefined) textField(request.pullRequest, "pullRequest", 2000);
  if (request.action === "active") return;
  textField(request.backend, "backend", 200);
  textField(request.threadId, "threadId", 200);
  if (request.action === "create") {
    textField(request.reason, "reason", 2000);
    textField(request.releaseWhen, "releaseWhen", 2000);
    if (request.dependency !== undefined) {
      const dependency = request.dependency;
      textField(dependency.backend, "dependency.backend", 200);
      textField(dependency.threadId, "dependency.threadId", 200);
      if (!dependency.target || !["local", "remote"].includes(dependency.target.scope)) throw new Error("dependency.target must identify a local or remote thread.");
      if (dependency.target.scope === "remote") textField(dependency.target.instanceId, "dependency.target.instanceId", 200);
      if (dependency.title !== undefined) textField(dependency.title, "dependency.title", 200);
      if (dependency.target.scope === "local" && dependency.backend === request.backend && dependency.threadId === request.threadId) throw new Error("A thread cannot wait on itself.");
    }
  }
  if (request.action === "resolve" || request.action === "cancel") {
    textField(request.holdId, "holdId", 200);
    textField(request.note, "note", 2000);
  }
}

function boundedHistory(holds: ThreadMergeHold[]): ThreadMergeHold[] {
  const retained = new Set(holds.filter((hold) => hold.status !== "waiting")
    .sort((left, right) => left.updatedAt - right.updatedAt).slice(-100).map((hold) => hold.id));
  return holds.filter((hold) => hold.status === "waiting" || retained.has(hold.id));
}

export function updateMergeHolds(
  previous: ThreadMergeHold[],
  request: ManageThreadMergeHoldsRequest & { backend: string; threadId: string },
  actor: string,
  now: number,
  pullRequestUrls: string[],
): ThreadMergeHold[] {
  if (request.action === "list" || request.action === "active") return previous;
  if (request.action === "create") {
    const reason = request.reason!.trim();
    const releaseWhen = request.releaseWhen!.trim();
    if (previous.some((hold) => hold.status === "waiting" && hold.reason === reason && hold.releaseWhen === releaseWhen
      && JSON.stringify(hold.dependency) === JSON.stringify(request.dependency))) return previous;
    if (previous.filter((hold) => hold.status === "waiting").length >= 32) throw new Error("This thread already has 32 merge holds. Resolve or cancel one first.");
    const hold: ThreadMergeHold = {
      id: randomUUID(), backend: request.backend, threadId: request.threadId,
      reason, releaseWhen, ...(request.dependency ? { dependency: request.dependency } : {}),
      pullRequestUrls, status: "waiting", createdAt: now, updatedAt: now, createdBy: actor,
    };
    return boundedHistory([...previous, hold]);
  }
  const hold = previous.find((item) => item.id === request.holdId);
  if (!hold) throw new Error("Merge hold not found for this thread.");
  const status = request.action === "resolve" ? "resolved" : "cancelled";
  if (hold.status === status) return previous;
  if (hold.status !== "waiting") throw new Error("This merge hold has already been cleared. Create a new hold if needed.");
  return boundedHistory(previous.map((item) => item === hold ? {
    ...hold, status, updatedAt: now, resolution: { note: request.note!.trim(), actor, at: now },
  } : item));
}

function prKey(url: string): string | undefined {
  const ref = parsePullRequestReferenceUrl(url);
  return ref ? JSON.stringify([ref.kind, ref.provider.toLowerCase(), ref.org.toLowerCase(), ref.repo.toLowerCase(), ref.number]) : undefined;
}

/** Shared by operator merge cards and agent merges; re-read at execution time. */
export function blockingMergeHolds(
  holds: ThreadMergeHold[],
  target: { backend: string; threadId: string; pullRequest?: string },
): ThreadMergeHold[] {
  const key = target.pullRequest ? prKey(target.pullRequest) : undefined;
  return holds.filter((hold) => hold.status === "waiting" && (
    (hold.backend === target.backend && hold.threadId === target.threadId)
    || (key !== undefined && hold.pullRequestUrls.some((url) => prKey(url) === key))
  ));
}

export function assertNoMergeHolds(holds: ThreadMergeHold[], target: { backend: string; threadId: string; pullRequest?: string }): void {
  const blocking = blockingMergeHolds(holds, target);
  if (blocking.length) throw new Error(`Merge held: ${blocking.map((hold) => `${hold.reason} (hold ${hold.id})`).join("; ")}. Resolve each hold with its findings, or ask the operator to clear it. Rebase and CI repair may continue. Do not bypass this hold with gh, glab, or another merge action.`);
}

/** Called on the owner. Only active reads cross peers, so reverse lookup cannot recurse. */
export async function appendMergeHoldDependents(
  response: ManageThreadMergeHoldsResponse,
  request: ManageThreadMergeHoldsRequest,
  runtime: FederatedThreadTargetRuntime,
): Promise<ManageThreadMergeHoldsResponse> {
  if (request.action !== "list" || request.includeDependents === false) return response;
  const localId = (await runtime.health()).instanceId;
  const peers = runtime.connectedPeerTargets().filter((peer) => peer.capabilities.includes("turn_control"));
  const results = await Promise.allSettled(peers.map(async (peer) => ({ peer,
    response: await runtime.remoteBackend(peer.target).manageThreadMergeHolds({ action: "active" }),
  })));
  results.forEach((result, index) => {
    if (result.status === "rejected") { (response.unavailablePeers ??= []).push(peers[index]!.label); return; }
    for (const hold of result.value.response.holds) {
      if (hold.dependency?.target.scope === "remote" && hold.dependency.target.instanceId === localId
        && hold.dependency.backend === (request.backend ?? "codex") && hold.dependency.threadId === request.threadId) {
        response.dependents.push({ hold, owner: result.value.peer.target });
      }
    }
  });
  return response;
}

/** A peer's local owner means that peer, while a ref back to the viewer means local. */
export function qualifyMergeHoldOwners(response: ManageThreadMergeHoldsResponse, owner: FederationRemoteTarget, viewerInstanceId?: string): ManageThreadMergeHoldsResponse {
  return { ...response, dependents: response.dependents.map((entry) => ({
    ...entry, owner: entry.owner?.scope === "remote"
      ? entry.owner.instanceId === viewerInstanceId ? { scope: "local" as const } : entry.owner
      : owner,
  })) };
}
