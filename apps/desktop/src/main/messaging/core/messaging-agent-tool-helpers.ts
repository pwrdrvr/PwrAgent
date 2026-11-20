import { findThreadForBinding } from "./messaging-callback-helpers";
import { type ActiveAgentMessagingOrigin } from "./messaging-backend-event-helpers";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isVisibleStreamOutcome } from "./messaging-reply-receipts";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import type { FederatedThreadRef } from "@pwragent/shared/contracts/federation";
import type {
  PwrAgentMessagingBoundThreadSummary,
  PwrAgentMessagingLocationSummary,
  PwrAgentMessagingManagedConversationSummary,
  PwrAgentMessagingResponse,
} from "@pwragent/shared/contracts/messaging-tools";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { MessagingBindingRecord, MessagingChannelRef, MessagingDeliveryResult, MessagingInboundEvent, MessagingImagePart, MessagingPrivateReplySource } from "@pwragent/messaging-interface";
import { type MessagingNavigationContext } from "./messaging-thread-state.js";

export const PRIVATE_REPLY_CONTINUATION_TTL_MS = 24 * 60 * 60 * 1_000;

export type AgentMessagingOriginResolution =
  | { ok: true; origin: ActiveAgentMessagingOrigin }
  | Extract<PwrAgentMessagingResponse, { ok: false }>;

export type AttachTargetResolution =
  | {
      ok: true;
      federatedThread?: FederatedThreadRef;
      thread: NavigationThreadSummary;
    }
  | Extract<PwrAgentMessagingResponse, { ok: false }>;

export function attachTargetNotFound(
  backend: AppServerBackendKind,
  threadId: string,
): Extract<PwrAgentMessagingResponse, { ok: false }> {
  return {
    ok: false,
    error: {
      code: "not_found",
      message:
        `Thread ${backend}:${threadId} is not an active attachable thread. `
        + "It may be archived, deleted, or unavailable; restore it in PwrAgent or choose another thread.",
    },
  };
}

export function readPdfToolString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readOptionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

export function readPdfToolPageNumbers(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const pageNumbers = value.map(readOptionalPositiveInteger);
  return pageNumbers.every((pageNumber) => pageNumber !== undefined)
    ? pageNumbers as number[]
    : undefined;
}

export function pdfToolFailure(error: unknown): Extract<PwrAgentMessagingResponse, { ok: false }> {
  const message = error instanceof Error ? error.message : "PDF attachment could not be read.";
  return {
    ok: false,
    error: {
      code:
        message.startsWith("No PDF attachments") ||
        message.startsWith("That PDF attachment")
          ? "not_found"
          : "invalid_arguments",
      message,
    },
  };
}

export function assistantImageDeliverySignature(images: readonly MessagingImagePart[]): string {
  return `images:${images.map((image) => image.sourceUrl ?? image.url).join("\0")}`;
}

export function outboundImageClaimAliases(
  values: readonly (string | undefined)[],
): string[] {
  const aliases = new Set<string>();
  for (const value of values) {
    if (!value) {
      continue;
    }
    aliases.add(value);
    if (
      value.startsWith("data:")
      || /^https?:\/\//iu.test(value)
    ) {
      continue;
    }
    if (path.isAbsolute(value)) {
      aliases.add(pathToFileURL(value).toString());
    }
  }
  return [...aliases];
}

export function privateReplySourceFromBinding(
  binding: MessagingBindingRecord,
): MessagingPrivateReplySource {
  return {
    authorizedActorIds: [...binding.authorizedActorIds],
    backend: binding.backend,
    channel: structuredClone(binding.channel),
    createdAt: binding.createdAt,
    displayName: binding.displayName,
    federatedThread: binding.federatedThread,
    id: binding.id,
    routingState: binding.routingState
      ? structuredClone(binding.routingState)
      : undefined,
    targetKind: binding.targetKind,
    threadId: binding.threadId,
    updatedAt: binding.updatedAt,
  };
}

export function summarizeMessagingConversation(
  conversation: MessagingChannelRef["conversation"],
): PwrAgentMessagingLocationSummary["conversation"] {
  return {
    id: conversation.id,
    kind: conversation.kind,
    parentId: conversation.parentId,
    parentConversationId: conversation.parentConversationId,
    workspaceId: conversation.workspaceId,
    title: conversation.title,
    parentTitle: conversation.parentTitle,
    ancestorTitle: conversation.ancestorTitle,
  };
}

export function summarizeMessagingActor(
  actor: MessagingInboundEvent["actor"],
): NonNullable<PwrAgentMessagingLocationSummary["actor"]> {
  return {
    platformUserId: actor.platformUserId,
    displayName: actor.displayName,
    username: actor.username,
    isBot: actor.isBot,
  };
}

export function summarizeMessagingBinding(
  binding: MessagingBindingRecord,
  thread?: PwrAgentMessagingBoundThreadSummary,
): PwrAgentMessagingLocationSummary["binding"] {
  return {
    id: binding.id,
    backend: binding.backend,
    threadId: binding.threadId,
    targetKind: binding.targetKind ?? "thread",
    displayName: binding.displayName,
    ...(thread ? { thread } : {}),
  };
}

export function isMessagingToolOriginBinding(
  binding: MessagingBindingRecord,
  navigation: MessagingNavigationContext | undefined,
): boolean {
  if (binding.backend === "codex" && navigation
    && findThreadForBinding(navigation, binding)?.agent) {
    return true;
  }
  if (binding.targetKind === "agent_thread") {
    return true;
  }
  if (binding.targetKind !== "thread" || !navigation) {
    return false;
  }
  return Boolean(findThreadForBinding(navigation, binding)?.handoffOrigin);
}

export function summarizeNavigationThreadForMessaging(
  thread: NavigationThreadSummary,
): PwrAgentMessagingBoundThreadSummary {
  const gitBranch = thread.gitBranch ?? thread.observedGitBranch;
  return {
    title: thread.title,
    titleSource: thread.titleSource,
    ...(thread.projectKey ? { projectKey: thread.projectKey } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    ...(thread.model ? { model: thread.model } : {}),
    ...(thread.executionMode ? { executionMode: thread.executionMode } : {}),
    ...(thread.agent?.name ? { agentName: thread.agent.name } : {}),
  };
}

export function responseAttributionLabel(
  binding: MessagingBindingRecord,
  thread: PwrAgentMessagingBoundThreadSummary | undefined,
): string {
  const targetKind = binding.targetKind ?? "thread";
  const identity = targetKind === "agent_thread"
    ? thread?.agentName
    : thread?.titleSource === "fallback"
      ? undefined
      : thread?.title;
  const normalized = identity?.replace(/\s+/g, " ").trim();
  if (normalized) {
    return targetKind === "agent_thread"
      ? `Agent: ${normalized}`
      : `Bound thread: ${normalized}`;
  }
  return targetKind === "agent_thread"
    ? "PwrAgent Agent"
    : "PwrAgent thread";
}

export function eventFromBinding(
  binding: MessagingBindingRecord,
  now: number,
): MessagingInboundEvent {
  return {
    id: `agent-origin:${binding.id}`,
    kind: "lifecycle",
    lifecycle: "bound",
    actor: {
      platformUserId: binding.authorizedActorIds[0] ?? "unknown",
      displayName: binding.displayName,
    },
    channel: binding.channel,
    receivedAt: now,
    routingState: binding.routingState,
  };
}

export function sanitizeMessagingChildTitle(title: string | undefined): string {
  const normalized = (title ?? "PwrAgent thread").replace(/\s+/g, " ").trim();
  return Array.from(normalized || "PwrAgent thread").slice(0, 100).join("");
}

export function managedConversationUnavailableMessage(
  summary: PwrAgentMessagingManagedConversationSummary,
): string {
  if (!summary.providerSupportsCreation) {
    return "This messaging provider does not support creating native child conversations.";
  }
  const operation = summary.operation;
  if (operation?.missingPermission) {
    return `PwrAgent cannot create a native child conversation because the provider permission ${operation.missingPermission} is missing.`;
  }
  if (operation?.reason) {
    return `PwrAgent cannot create a native child conversation: ${operation.reason}.`;
  }
  if (summary.errorMessage) {
    return `PwrAgent cannot create a native child conversation: ${summary.errorMessage}.`;
  }
  return "PwrAgent cannot create a native child conversation in the current messaging location.";
}

export function isVisibleAssistantStreamDelivery(result: MessagingDeliveryResult): boolean {
  return isVisibleStreamOutcome(result.outcome);
}
