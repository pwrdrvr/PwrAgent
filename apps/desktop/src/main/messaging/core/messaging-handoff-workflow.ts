import type {
  HandoffThreadWorkspaceRequest, HandoffThreadWorkspaceResponse, MessagingPermissionId, NavigationThreadSummary,
} from "@pwragent/shared";
import { capabilityProfilePageSize } from "@pwragent/messaging-interface";
import type {
  MessagingActiveTurnSummary, MessagingBindingRecord, MessagingCapabilityProfile, MessagingDeliveryResult,
  MessagingInboundCallbackEvent, MessagingInboundEvent, MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";
import type { MessagingBackendBridge } from "./messaging-adapter";
import { buildMessagingAuditContext } from "./messaging-audit";
import { federationTargetForBinding, type MessagingDeliveryGuard } from "./messaging-backend-event-helpers";
import { handoffContextForBinding } from "./messaging-binding-helpers";
import type { MessagingBindingService } from "./messaging-binding-service";
import type { MessagingBrowseQueryPool } from "./messaging-browse-query-pool";
import { branchPageIndexFromValue } from "./messaging-callback-helpers";
import { buildErrorIntent, buildStatusIntent } from "./messaging-renderer";
import {
  buildHandoffBranchPickerIntent, buildHandoffConfirmationIntent, buildHandoffOverviewIntent,
  buildHandoffProjectPickerIntent, handoffRequestFromValue, type MessagingWorkspaceHandoffContext,
} from "./messaging-status-card";
import type { MessagingStoreLike } from "./messaging-storage";
import type { MessagingThreadContext } from "./messaging-thread-state";

interface MessagingHandoffContext {
  readonly backend: Pick<MessagingBackendBridge, "getNavigationQueryPage" | "handoffThreadWorkspace" | "readThreadWorktreeLock">;
  readonly store: Pick<MessagingStoreLike, "getBinding" | "findActivePendingIntentForChannel" | "deletePendingIntent">;
  readonly queryPool: Pick<MessagingBrowseQueryPool, "read" | "release">;
  readonly capabilityProfile: MessagingCapabilityProfile;
  readonly now: () => number;
  readonly newIntentId: (prefix: string) => string;
  readonly getActiveTurn: (binding: MessagingBindingRecord) => MessagingActiveTurnSummary | undefined;
  readonly readBoundWorkspaceContext: (binding: MessagingBindingRecord) => Promise<MessagingThreadContext>;
  readonly readBoundNavigationThread: (binding: MessagingBindingRecord, probeWorkingStates?: boolean) => Promise<NavigationThreadSummary | undefined>;
  readonly deliver: (intent: MessagingSurfaceIntent, binding?: MessagingBindingRecord, event?: MessagingInboundEvent, guard?: MessagingDeliveryGuard) => Promise<MessagingDeliveryResult>;
  readonly deliverAndStoreStatusSubmode: MessagingBindingService["deliverAndStoreStatusSubmode"];
  readonly updateBindingAfterHandoff: MessagingBindingService["updateBindingAfterHandoff"];
  readonly renderBindingStatus: MessagingBindingService["renderBindingStatus"];
  /** Render-time probe: never audits or notifies. */
  readonly actorHasPermission: (event: MessagingInboundEvent, permission: MessagingPermissionId) => boolean;
  /** Enforcement: audits a denial and tells the actor. */
  readonly requirePermission: (
    event: MessagingInboundEvent, permission: MessagingPermissionId, auditAction: string,
  ) => Promise<boolean>;
}

/**
 * Unlocking someone else's Git lock removes a worktree, so it needs the
 * archive permission as well as handoff, as `mutate_thread` archive does.
 */
export const UNLOCK_AND_HAND_OFF_PERMISSIONS: readonly MessagingPermissionId[] = [
  "thread.control.handoff",
  "thread.control.archive",
];

const ACTIVE_TURN_HANDOFF_ERROR =
  "Worktree/local migration is not available while a turn is in progress. Resubmit when the turn completes.";

export class MessagingHandoffWorkflow {
  constructor(private readonly context: MessagingHandoffContext) {}

  async presentHandoffOverview(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    if (this.handoffBlockedByActiveTurn(binding)) {
      await this.deliverHandoffUnavailable(binding, event, ACTIVE_TURN_HANDOFF_ERROR);
      return;
    }

    if (!this.context.backend.handoffThreadWorkspace) {
      await this.deliverHandoffUnavailable(binding, event, "This runtime does not expose workspace handoff through messaging.");
      return;
    }

    const navigation = await this.context.readBoundWorkspaceContext(binding);
    const context = handoffContextForBinding(binding, navigation);
    if (!context) {
      await this.deliverHandoffUnavailable(binding, event, "This thread does not have enough Git workspace metadata for handoff.");
      return;
    }

    await this.context.deliverAndStoreStatusSubmode(
      {
        ...buildHandoffOverviewIntent({
          id: this.context.newIntentId("handoff-overview"),
          capabilityProfile: this.context.capabilityProfile,
          binding,
          context,
          createdAt: this.context.now(),
        }),
        audit: this.buildHandoffAudit("handoff.overview", binding, event),
      },
      binding,
      event,
    );
  }

  async presentHandoffProjectPicker(
    binding: MessagingBindingRecord,
    event: MessagingInboundCallbackEvent,
  ): Promise<void> {
    if (this.handoffBlockedByActiveTurn(binding)) {
      await this.deliverHandoffUnavailable(binding, event, ACTIVE_TURN_HANDOFF_ERROR);
      return;
    }
    const context = handoffContextForBinding(binding, await this.context.readBoundWorkspaceContext(binding));
    if (!context || !this.context.backend.getNavigationQueryPage) {
      await this.deliverHandoffUnavailable(binding, event, "Project selection is unavailable. Use /status to refresh.");
      return;
    }
    const bindingTarget = federationTargetForBinding(binding);
    const target = bindingTarget?.scope === "remote" ? bindingTarget : undefined;
    const pageIndex = branchPageIndexFromValue(event.value);
    const sessionId = `handoff-projects:${binding.id}`;
    if (pageIndex === 0) this.context.queryPool.release(sessionId);
    const page = await this.context.queryPool.read({
      sessionId,
      query: { kind: "messaging-projects" },
      owners: [{ target, label: target?.instanceId ?? "Local" }],
      pageSize: Math.min(8, (this.context.capabilityProfile ? capabilityProfilePageSize(this.context.capabilityProfile, 4, 8) : 8) || 8),
      pageIndex,
    });
    await this.context.deliverAndStoreStatusSubmode({
      ...buildHandoffProjectPickerIntent({
        id: this.context.newIntentId("handoff-projects"),
        capabilityProfile: this.context.capabilityProfile,
        binding, context, createdAt: this.context.now(),
        page: { ...page, projects: page.projects.filter((directory) =>
          directory.kind === "directory" && directory.path && directory.path !== context.workingDirectoryPath) },
      }),
      audit: this.buildHandoffAudit("handoff.projects", binding, event),
    }, binding, event);
  }

  async presentHandoffBranchPicker(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
    pageIndex = 0,
  ): Promise<void> {
    if (this.handoffBlockedByActiveTurn(binding)) {
      await this.deliverHandoffUnavailable(binding, event, ACTIVE_TURN_HANDOFF_ERROR);
      return;
    }

    const navigation = await this.context.readBoundWorkspaceContext(binding);
    const context = handoffContextForBinding(binding, navigation);
    if (!context || context.workspaceKind !== "local") {
      await this.deliverHandoffUnavailable(binding, event, "This thread is not currently in a Local workspace that can move to a worktree.");
      return;
    }
    if (context.leaveLocalBranches.length === 0) {
      await this.deliverHandoffUnavailable(binding, event, "No safe branch choices are available to leave checked out in Local.");
      return;
    }

    await this.context.deliverAndStoreStatusSubmode(
      {
        ...buildHandoffBranchPickerIntent({
          id: this.context.newIntentId("handoff-branch"),
          capabilityProfile: this.context.capabilityProfile,
          binding,
          context,
          createdAt: this.context.now(),
          pageIndex,
        }),
        audit: this.buildHandoffAudit("handoff.branch_picker", binding, event),
      },
      binding,
      event,
    );
  }

  async presentHandoffConfirmation(
    binding: MessagingBindingRecord,
    event: MessagingInboundCallbackEvent,
  ): Promise<void> {
    if (this.handoffBlockedByActiveTurn(binding)) {
      await this.deliverHandoffUnavailable(binding, event, ACTIVE_TURN_HANDOFF_ERROR);
      return;
    }

    const navigation = await this.context.readBoundWorkspaceContext(binding);
    const context = handoffContextForBinding(binding, navigation);
    const request = handoffRequestFromValue(event.value);
    if (!context || !request) {
      await this.deliverInvalidHandoffSelection(binding, event);
      return;
    }

    const validation = validateHandoffRequest(request, context);
    if (!validation.valid) {
      await this.deliverHandoffUnavailable(binding, event, validation.reason);
      return;
    }

    const worktreeLock = await this.readSourceWorktreeLock(binding, context, request);
    await this.context.deliverAndStoreStatusSubmode(
      {
        ...buildHandoffConfirmationIntent({
          id: this.context.newIntentId("handoff-confirm"),
          capabilityProfile: this.context.capabilityProfile,
          binding,
          context,
          createdAt: this.context.now(),
          targetPath: request.targetPath,
          projectPageIndex: branchPageIndexFromValue(event.value),
          leaveLocalBranch: request.leaveLocalBranch,
          strategy: request.strategy,
          direction: request.direction,
          ...(worktreeLock ? {
            worktreeLock,
            // Built for the actor who asked; the callback re-checks whoever clicks.
            canUnlockWorktree: UNLOCK_AND_HAND_OFF_PERMISSIONS
              .every((permission) => this.context.actorHasPermission(event, permission)),
          } : {}),
        }),
        audit: this.buildHandoffAudit(
          `handoff.confirmation.${request.direction}`,
          binding,
          event,
        ),
      },
      binding,
      event,
    );
  }

  async executeHandoff(
    binding: MessagingBindingRecord,
    event: MessagingInboundCallbackEvent,
  ): Promise<void> {
    if (this.handoffBlockedByActiveTurn(binding)) {
      await this.deliverHandoffUnavailable(binding, event, ACTIVE_TURN_HANDOFF_ERROR);
      return;
    }

    if (!this.context.backend.handoffThreadWorkspace) {
      await this.deliverHandoffUnavailable(binding, event, "This runtime does not expose workspace handoff through messaging.");
      return;
    }

    const request = handoffRequestFromValue(event.value);
    if (!request) {
      await this.deliverInvalidHandoffSelection(binding, event);
      return;
    }
    // Whatever button or value carried it, an approval to unlock needs the
    // archive permission too. The top-guard already required handoff.
    if (request.approvedLockReason !== undefined) {
      for (const permission of UNLOCK_AND_HAND_OFF_PERMISSIONS) {
        if (!(await this.context.requirePermission(event, permission, "handoff:confirm-unlock"))) return;
      }
    }

    const currentBinding = await this.context.store.getBinding(binding.id);
    if (
      !currentBinding ||
      currentBinding.revokedAt ||
      currentBinding.backend !== binding.backend ||
      currentBinding.threadId !== binding.threadId ||
      !currentBinding.authorizedActorIds.includes(event.actor.platformUserId)
    ) {
      await this.deliverHandoffUnavailable(binding, event, "That handoff prompt is stale. Use /status to refresh.");
      return;
    }

    const navigation = await this.context.readBoundWorkspaceContext(currentBinding);
    const context = handoffContextForBinding(currentBinding, navigation);
    if (!context) {
      await this.deliverHandoffUnavailable(currentBinding, event, "This thread no longer has enough Git workspace metadata for handoff.");
      return;
    }
    const validation = validateHandoffRequest(request, context);
    if (!validation.valid) {
      await this.deliverHandoffUnavailable(currentBinding, event, validation.reason);
      return;
    }

    await this.context.deliver(
      {
        ...buildStatusIntent({
          id: this.context.newIntentId("handoff-running"),
          createdAt: this.context.now(),
          status: "working",
          text: `Running workspace handoff: ${formatHandoffDirection(request.direction)}.`,
        }),
        audit: this.buildHandoffAudit(
          `handoff.running.${request.direction}`,
          currentBinding,
          event,
        ),
      },
      currentBinding,
      event,
    );

    try {
      const result = await this.context.backend.handoffThreadWorkspace({
        ...request,
        federationTarget: federationTargetForBinding(currentBinding),
      });
      await this.clearActiveHandoffIntent(event);
      const refreshedNavigation: MessagingThreadContext = { kind: "thread", thread: await this.context.readBoundNavigationThread(currentBinding) };
      const updatedBinding = await this.context.updateBindingAfterHandoff(
        currentBinding,
        result,
      );
      await this.context.deliver(
        {
          ...buildStatusIntent({
            id: this.context.newIntentId("handoff-completed"),
            createdAt: this.context.now(),
            status: "completed",
            text: handoffSuccessText(result),
          }),
          audit: this.buildHandoffAudit(
            `handoff.completed.${request.direction}`,
            updatedBinding,
            event,
          ),
        },
        updatedBinding,
        event,
      );
      await this.context.renderBindingStatus(updatedBinding, event, refreshedNavigation);
    } catch (error) {
      await this.context.deliver(
        {
          ...buildErrorIntent({
            id: this.context.newIntentId("handoff-failed"),
            createdAt: this.context.now(),
            title: "Handoff failed",
            body: error instanceof Error ? error.message : String(error),
            recoverable: true,
          }),
          audit: this.buildHandoffAudit(
            `handoff.failed.${request.direction}`,
            currentBinding,
            event,
          ),
        },
        currentBinding,
        event,
      );
    }
  }

  async clearActiveHandoffIntent(event: MessagingInboundEvent): Promise<void> {
    const pendingIntent = await this.context.store.findActivePendingIntentForChannel({
      actorId: event.actor.platformUserId,
      channel: event.channel,
      now: this.context.now(),
    });
    if (pendingIntent && pendingIntent.intent.id.includes("handoff")) {
      await this.context.store.deletePendingIntent(pendingIntent.id);
    }
  }

  /**
   * Someone else's lock on the worktree this handoff leaves. PwrAgent's own
   * drive lock is never reported, and a failed read asks nothing: without an
   * approval the owner keeps a locked worktree.
   */
  private async readSourceWorktreeLock(
    binding: MessagingBindingRecord,
    context: MessagingWorkspaceHandoffContext,
    request: HandoffThreadWorkspaceRequest,
  ): Promise<{ lockReason: string } | undefined> {
    if (context.workspaceKind !== "worktree" || request.direction === "to-project" || !this.context.backend.readThreadWorktreeLock) {
      return undefined;
    }
    try {
      const response = await this.context.backend.readThreadWorktreeLock({
        backend: context.backend,
        threadId: context.threadId,
        worktreePath: context.workingDirectoryPath,
        federationTarget: federationTargetForBinding(binding),
      });
      return response.lock ? { lockReason: response.lock.lockReason } : undefined;
    } catch {
      return undefined;
    }
  }

  private handoffBlockedByActiveTurn(binding: MessagingBindingRecord): boolean {
    const activeTurn = this.context.getActiveTurn(binding);
    return Boolean(activeTurn && ["working", "waiting"].includes(activeTurn.status));
  }

  private async deliverHandoffUnavailable(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
    body: string,
  ): Promise<void> {
    await this.context.deliver(
      {
        ...buildErrorIntent({
          id: this.context.newIntentId("handoff-unavailable"),
          createdAt: this.context.now(),
          title: "Handoff unavailable",
          body,
          recoverable: true,
        }),
        audit: this.buildHandoffAudit("handoff.unavailable", binding, event),
      },
      binding,
      event,
    );
  }

  private async deliverInvalidHandoffSelection(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.context.deliver(
      {
        ...buildErrorIntent({
          id: this.context.newIntentId("handoff-invalid"),
          createdAt: this.context.now(),
          title: "Invalid handoff selection",
          body: "That handoff selection is no longer available. Use /status to refresh.",
          recoverable: true,
        }),
        audit: this.buildHandoffAudit("handoff.invalid_selection", binding, event),
      },
      binding,
      event,
    );
  }

  private buildHandoffAudit(
    action: string,
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): NonNullable<MessagingSurfaceIntent["audit"]> {
    return buildMessagingAuditContext({
      action,
      actor: event.actor,
      backend: binding.backend,
      bindingId: binding.id,
      channel: binding.channel,
      now: this.context.now(),
      threadId: binding.threadId,
    });
  }
}

function validateHandoffRequest(
  request: HandoffThreadWorkspaceRequest,
  context: MessagingWorkspaceHandoffContext,
): { valid: true } | { valid: false; reason: string } {
  const expectedDirections: HandoffThreadWorkspaceRequest["direction"][] =
    context.workspaceKind === "local" ? ["local-to-worktree"] : ["worktree-to-local", "worktree-to-worktree"];
  if (
    request.backend !== context.backend ||
    request.threadId !== context.threadId ||
    (request.direction !== "to-project" && !expectedDirections.includes(request.direction)) ||
    request.repositoryPath !== context.repositoryPath ||
    request.sourcePath !== context.workingDirectoryPath
  ) {
    return {
      valid: false,
      reason: "That handoff prompt is stale. Use /status to refresh.",
    };
  }
  if (request.direction === "to-project") {
    return request.targetPath?.trim()
      ? { valid: true }
      : { valid: false, reason: "Choose a destination project before handoff." };
  }
  if (!context.branch) {
    return { valid: false, reason: "This workspace has no Git branch available for handoff." };
  }
  if (context.branch && request.sourceBranch !== context.branch) {
    return {
      valid: false,
      reason: "The thread branch changed. Use /status to refresh before handoff.",
    };
  }
  if (request.direction === "worktree-to-worktree") {
    return request.strategy === "new-branch" && !request.newBranchName?.trim()
      ? { valid: false, reason: "Choose the new branch name before handoff." }
      : { valid: true };
  }
  if (request.direction === "local-to-worktree") {
    if (request.strategy === "detached-changes") {
      return { valid: true };
    }
    if (request.strategy === "new-branch") {
      if (!request.newBranchName?.trim()) {
        return {
          valid: false,
          reason: "Choose the new branch name before handoff.",
        };
      }
      return { valid: true };
    }
    if (!request.leaveLocalBranch) {
      return {
        valid: false,
        reason: "Choose the branch to leave checked out in Local before handoff.",
      };
    }
    if (!context.leaveLocalBranches.includes(request.leaveLocalBranch)) {
      return {
        valid: false,
        reason: "That Local branch choice is no longer available. Use /status to refresh.",
      };
    }
  }
  return { valid: true };
}

function formatHandoffDirection(
  direction: HandoffThreadWorkspaceRequest["direction"],
): string {
  return direction === "to-project" ? "Move to Project"
    : direction === "local-to-worktree" ? "Local to new worktree"
      : direction === "worktree-to-worktree" ? "Worktree to new worktree" : "Worktree to Local";
}

export function handoffSuccessText(result: HandoffThreadWorkspaceResponse): string {
  const kept = result.keptSourceWorktree;
  return [
    `Workspace handoff complete: ${formatHandoffDirection(result.direction)}.`,
    `Workspace: ${result.workMode === "worktree" ? "Worktree" : "Local"}`,
    `Target: ${result.targetPath}`,
    result.branch ? `Branch: ${result.branch}` : undefined,
    kept
      ? kept.lockReason
        ? `The worktree was kept because Git has it locked: ${kept.lockReason}`
        : "The worktree was kept because Git has it locked."
      : undefined,
    ...result.warnings.map((warning) => `Warning: ${warning}`),
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
