import { randomUUID } from "node:crypto";
import {
  THREAD_MERGE_HOLD_FOLLOW_UP_STEP_MAX_LENGTH,
  THREAD_MERGE_HOLD_MAX_FOLLOW_UP_STEPS,
  THREAD_TODO_DETAIL_MAX_LENGTH,
  THREAD_TODO_TITLE_MAX_LENGTH,
  type FederationRemoteTarget,
  type ManageThreadMergeHoldsRequest,
  type ManageThreadMergeHoldsResponse,
  type ThreadMergeHold,
  type ThreadTodoAction,
  type ThreadTodoItem,
} from "@pwragent/shared";
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
    if (request.releaseWhen !== undefined) textField(request.releaseWhen, "releaseWhen", 2000);
    if (request.followUp !== undefined) {
      if (!Array.isArray(request.followUp) || request.followUp.length > THREAD_MERGE_HOLD_MAX_FOLLOW_UP_STEPS) {
        throw new Error(`followUp must list at most ${THREAD_MERGE_HOLD_MAX_FOLLOW_UP_STEPS} steps.`);
      }
      request.followUp.forEach((step, index) => textField(step, `followUp[${index}]`, THREAD_MERGE_HOLD_FOLLOW_UP_STEP_MAX_LENGTH));
    }
    if (request.offerToSend !== undefined && typeof request.offerToSend !== "boolean") throw new Error("offerToSend must be a boolean.");
    if (request.offerToSend && !request.followUp?.length) throw new Error("offerToSend needs followUp steps to send.");
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
    const releaseWhen = request.releaseWhen?.trim() || undefined;
    const followUp = request.followUp?.map((step) => step.trim());
    const offerToSend = Boolean(request.offerToSend && followUp?.length);
    if (previous.some((hold) => hold.status === "waiting" && hold.reason === reason && hold.releaseWhen === releaseWhen
      && JSON.stringify(hold.followUp ?? []) === JSON.stringify(followUp ?? [])
      && Boolean(hold.offerToSend) === offerToSend
      && JSON.stringify(hold.dependency) === JSON.stringify(request.dependency))) return previous;
    if (previous.filter((hold) => hold.status === "waiting").length >= 32) throw new Error("This thread already has 32 merge holds. Resolve or cancel one first.");
    const hold: ThreadMergeHold = {
      id: randomUUID(), backend: request.backend, threadId: request.threadId,
      reason, ...(releaseWhen ? { releaseWhen } : {}),
      ...(followUp?.length ? { followUp } : {}), ...(offerToSend ? { offerToSend } : {}),
      ...(request.dependency ? { dependency: request.dependency } : {}),
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

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Card key and unique source id: one wait raises at most one reminder. */
export function mergeHoldReminderKey(holdId: string): string {
  return `merge-hold:${holdId}`;
}

function doneBy(hold: ThreadMergeHold, actor: string): string {
  if (actor === "operator") return "you";
  const dependency = hold.dependency;
  if (dependency && actor === `agent:${dependency.backend}:${dependency.threadId}`) return dependency.title ?? "the thread it waited on";
  if (actor === `agent:${hold.backend}:${hold.threadId}`) return "this thread's agent";
  if (actor.startsWith("agent:")) return "another thread's agent";
  return actor.startsWith("peer:") ? actor.slice("peer:".length) : actor;
}

export type MergeHoldReminderCard = {
  backend: ThreadMergeHold["backend"];
  threadId: string;
  dependencyId: string;
  key: string;
  title: string;
  detail: string;
  items?: ThreadTodoItem[];
  action?: Extract<ThreadTodoAction, { type: "send_message" }>;
};

/**
 * The operator's reminder for a wait that was marked done: "Windows
 * validation done: rebase onto #3291 (+2 more)", with the follow-up as
 * checkable steps. It starts no turn. When the operator asked for it, the
 * card offers to send the steps to the waiting thread.
 */
export function buildMergeHoldReminder(hold: ThreadMergeHold, stillWaiting: number): MergeHoldReminderCard {
  const label = hold.dependency?.title?.trim() || hold.reason;
  const steps = hold.followUp ?? [];
  const more = steps.length > 1 ? ` (+${steps.length - 1} more)` : "";
  const title = steps.length
    ? `${clip(label, 60)} done: ${clip(steps[0]!, THREAD_TODO_TITLE_MAX_LENGTH - Math.min(label.length, 60) - more.length - 7)}${more}`
    : `${clip(label, THREAD_TODO_TITLE_MAX_LENGTH - 5)} done`;
  const resolution = hold.resolution;
  const detail = [
    `Waited for: ${hold.reason}`,
    ...resolution ? [`Done: ${resolution.note}`, `Marked done by ${doneBy(hold, resolution.actor)}.`] : [],
    stillWaiting > 0
      ? `Merging still waits on ${stillWaiting === 1 ? "one other wait" : `${stillWaiting} other waits`}.`
      : "Merging is no longer held.",
  ].join("\n");
  const prompt = steps.length ? [
    `${label} is done.${resolution ? ` ${resolution.note}` : ""}`,
    "",
    "Now:",
    ...steps.map((step, index) => `${index + 1}. ${step}`),
  ].join("\n") : "";
  return {
    backend: hold.backend, threadId: hold.threadId,
    dependencyId: mergeHoldReminderKey(hold.id), key: mergeHoldReminderKey(hold.id),
    title: clip(title, THREAD_TODO_TITLE_MAX_LENGTH),
    detail: clip(detail, THREAD_TODO_DETAIL_MAX_LENGTH),
    ...(steps.length ? { items: steps.map((text, index) => ({ id: `step-${index + 1}`, text, checked: false })) } : {}),
    ...(hold.offerToSend && prompt ? { action: { type: "send_message" as const, prompt, target: { backend: hold.backend, threadId: hold.threadId } } } : {}),
  };
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
  if (blocking.length) throw new Error(`Merge held: ${blocking.map((hold) => `${hold.reason} (hold ${hold.id})`).join("; ")}. Merging waits until each is marked done (resolve with its findings) or the operator stops waiting. Rebase and CI repair may continue. Do not bypass this hold with gh, glab, or another merge action.`);
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
