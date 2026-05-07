import { createHash, randomUUID } from "node:crypto";
import { buildThreadIdentityKey } from "@pwragent/shared";
import type {
  AgentEvent,
  AppServerTurnInputItem,
  AppServerBackendKind,
  AppServerPendingRequestNotification,
  AppServerToolRequestUserInputNotification,
  HandoffThreadWorkspaceRequest,
  HandoffThreadWorkspaceResponse,
  LinkedDirectorySummary,
  MessagingToolUpdateMode,
  NavigationDirectorySummary,
  NavigationSnapshot,
  NavigationThreadSummary,
  ThreadExecutionMode,
  ThreadIdentifier,
} from "@pwragent/shared";
import type {
  MessagingBindingRecord,
  MessagingCallbackHandleRecord,
  MessagingBrowseSessionRecord,
  MessagingActiveTurnSummary,
  MessagingChannelKind,
  MessagingConfirmationIntent,
  MessagingDeliveryResult,
  MessagingInboundCallbackEvent,
  MessagingInboundCommandEvent,
  MessagingInboundEvent,
  MessagingInboundMediaEvent,
  MessagingInboundTextEvent,
  MessagingJsonValue,
  MessagingMessageIntent,
  MessagingPendingIntentRecord,
  MessagingStreamUpdateIntent,
  MessagingSurfaceRef,
  MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";
import {
  buildHelpActions,
  formatMessagingCommandHelpBody,
  matchMessagingCommandVerb,
  paginateHelpCatalog,
} from "./messaging-command-catalog.js";
import { buildMessagingConversationKey } from "./messaging-store.js";
import type { MessagingStoreLike } from "../../state/messaging-store-sqlite";
import type { MessagingCapabilityProfile } from "@pwragent/messaging-interface";
import type { MessagingAdapter, MessagingBackendBridge } from "./messaging-adapter.js";
import {
  buildActivityIntent,
  buildApprovalIntent,
  buildConfirmationIntent,
  buildErrorIntent,
  buildQuestionnaireIntent,
  buildStatusIntent,
  buildToolUpdateBatchMessageIntent,
  buildToolUpdateMessageIntent,
} from "./messaging-renderer.js";
import { buildMessagingAuditContext } from "./messaging-audit.js";
import { getMainLogger } from "../../log.js";
import { DeterministicInteractionMapper } from "./deterministic-interaction-mapper.js";
import { actionsForIntent } from "./deterministic-interaction-mapper.js";
import type { MessagingInteractionMapper } from "./interaction-mapper.js";
import {
  buildResumeIntent,
  directoryForProjectSelection,
  parseResumeCommandArgs,
  resumeBrowserPageSize,
  selectProjectFromValue,
  selectThreadFromValue,
} from "./messaging-resume-browser.js";
import {
  buildBindingStatusIntent,
  buildHandoffBranchPickerIntent,
  buildHandoffConfirmationIntent,
  buildHandoffOverviewIntent,
  buildStatusModelPickerIntent,
  buildStatusReasoningPickerIntent,
  formatExecutionModeLabel,
  handoffRequestFromValue,
  nextMessagingToolUpdateMode,
  resolveMessagingToolUpdateMode,
  type MessagingWorkspaceHandoffContext,
} from "./messaging-status-card.js";
import { resolveMessagingThreadState } from "./messaging-thread-state.js";
import { summarizeToolActivityFromBackendEvent } from "./messaging-tool-activity.js";
import {
  MessagingToolUpdatePolicy,
  type MessagingToolUpdatePolicyDelivery,
} from "./messaging-tool-update-policy.js";
import {
  DEFAULT_MESSAGING_ATTACHMENT_POLICY,
  processMessagingAttachments,
  type MessagingAttachmentPolicy,
  type MessagingAttachmentRejection,
} from "./messaging-attachment-processor.js";
import {
  MessagingTurnAdmission,
  threadKeyForBinding,
  type MessagingQueuedTurnEntry,
  type MessagingTurnAdmissionBundle,
  type MessagingTurnInputEvent,
} from "./messaging-turn-admission.js";
const DEFAULT_PENDING_INTENT_TTL_MS = 15 * 60 * 1000;
const TYPING_ACTIVITY_LEASE_MS = 15_000;
const TYPING_ACTIVITY_REFRESH_MS = 10_000;
const DEFAULT_INPUT_DEBOUNCE_MS = 500;
// Provider adapters own stricter platform pacing; the generic layer only
// coalesces noisy token deltas into human-visible refreshes.
const STREAM_UPDATE_REFRESH_MS = 1_000;
const messagingControllerLog = getMainLogger("pwragent:messaging");

type AssistantStreamDelta = {
  delta: string;
  itemId: string;
  streamKey: string;
  threadId: ThreadIdentifier;
  turnId?: string;
};

type AssistantStreamBuffer = AssistantStreamDelta & {
  lastEmittedAt: number;
  sequence: number;
  surface?: MessagingSurfaceRef;
  text: string;
};

type ExecutionModeResolution = {
  mode: ThreadExecutionMode | undefined;
  source: "thread" | "binding-preferences" | "permissions-mode" | "unset";
};

function resolveExecutionModeForBinding(
  binding: MessagingBindingRecord,
  navigation?: NavigationSnapshot,
): ExecutionModeResolution {
  const thread = findThreadForBinding(navigation, binding);
  if (thread?.executionMode) {
    return { mode: thread.executionMode, source: "thread" };
  }
  if (binding.preferences?.executionMode) {
    return { mode: binding.preferences.executionMode, source: "binding-preferences" };
  }
  if (binding.preferences?.permissionsMode === "full-access") {
    return { mode: "full-access", source: "permissions-mode" };
  }
  if (binding.preferences?.permissionsMode === "default") {
    return { mode: "default", source: "permissions-mode" };
  }
  return { mode: undefined, source: "unset" };
}

function executionModeForBinding(
  binding: MessagingBindingRecord,
  navigation?: NavigationSnapshot,
): ThreadExecutionMode | undefined {
  return resolveExecutionModeForBinding(binding, navigation).mode;
}

function turnSettingsForBinding(
  binding: MessagingBindingRecord,
  navigation?: NavigationSnapshot,
): {
  executionMode?: ThreadExecutionMode;
  fastMode?: boolean;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
} {
  const thread = findThreadForBinding(navigation, binding);
  return {
    executionMode: executionModeForBinding(binding, navigation),
    fastMode: thread?.fastMode ?? binding.preferences?.fastMode,
    model: thread?.model ?? binding.preferences?.model,
    reasoningEffort: thread?.reasoningEffort ?? binding.preferences?.reasoningEffort,
    serviceTier: thread?.serviceTier ?? binding.preferences?.serviceTier,
  };
}

function findThreadForBinding(
  navigation: NavigationSnapshot | undefined,
  binding: MessagingBindingRecord,
): NavigationThreadSummary | undefined {
  return navigation?.threads.find(
    (thread) => thread.source === binding.backend && thread.id === binding.threadId,
  );
}

function formatAttachmentRejections(
  rejections: MessagingAttachmentRejection[],
): string {
  return rejections
    .map((rejection) => `${rejection.name}: ${rejection.reason}`)
    .join("\n");
}

type MessagingControllerLogger = {
  debug?(message: string, data?: Record<string, unknown>): void;
  info?(message: string, data?: Record<string, unknown>): void;
  warn?(message: string, data?: Record<string, unknown>): void;
};

type MessagingToolUpdateDefaultModeResolver =
  | MessagingToolUpdateMode
  | (() => MessagingToolUpdateMode | Promise<MessagingToolUpdateMode>);

type QueuedTurnAction = {
  entryId: string;
  kind: "cancel" | "steer";
};

/**
 * Per-binding tracking of a posted "permissions queued" audit message so
 * we can edit it in place when the queue resolves (cancelled / applied).
 * One controller-side map keyed by `${backend}:${threadId}` is enough —
 * only one queued mode change can exist per thread at a time, and the
 * registry's queueCleared notification is per-thread.
 */
type PendingQueueAuditMessage = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  /** ULID-shaped queueId from the registry, used for the cancel button action id. */
  queueId: string;
  fromExecutionMode: ThreadExecutionMode;
  toExecutionMode: ThreadExecutionMode;
  queuedAt: number;
  /** Surface refs for every binding we successfully posted to. */
  surfaces: Map<string, MessagingSurfaceRef>;
};

const PERMISSIONS_QUEUE_CANCEL_ACTION_PREFIX = "permissions:queue:cancel:";

export type MessagingControllerOptions = {
  adapter: MessagingAdapter;
  authorizedActorIds: string[];
  backend: MessagingBackendBridge;
  channel?: MessagingChannelKind;
  interactionMapper?: MessagingInteractionMapper;
  logger?: MessagingControllerLogger;
  now?: () => number;
  inputDebounceMs?: number;
  pendingIntentTtlMs?: number;
  attachmentPolicy?: Partial<MessagingAttachmentPolicy>;
  store: MessagingStoreLike;
  toolUpdateDefaultMode?: MessagingToolUpdateDefaultModeResolver;
  /**
   * Notification hook invoked after any binding mutation the
   * controller performs (create, conversation-metadata refresh,
   * conversation-title sync, detach). The runtime supplies a callback
   * that broadcasts a renderer-bound IPC event so the UI re-fetches the
   * navigation snapshot and the binding chip reflects the new state
   * immediately. Best-effort — exceptions thrown by the listener must
   * not abort the controller's mutation flow.
   */
  onBindingChanged?: () => void;
};

export class MessagingController {
  private readonly authorizedActorIds: Set<string>;
  private readonly capabilityProfile: MessagingCapabilityProfile;
  private readonly deliveredAssistantMessageKeys = new Set<string>();
  private readonly assistantStreamBuffers = new Map<string, AssistantStreamBuffer>();
  private readonly assistantStreamDeliveryQueues = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly pendingIntentTtlMs: number;
  private readonly interactionMapper: MessagingInteractionMapper;
  private readonly activeTurnsByThreadKey = new Map<string, MessagingActiveTurnSummary>();
  private readonly typingActivityLastSignaledAt = new Map<string, number>();
  private readonly logger: MessagingControllerLogger;
  private readonly toolUpdatePolicy: MessagingToolUpdatePolicy;
  private readonly turnAdmission: MessagingTurnAdmission;
  /**
   * Per-thread map of the most-recent "permissions queued" audit message
   * we posted to each bound conversation. Cleared when the queue resolves
   * (cancelled or applied) and we successfully edit the messages in
   * place. Keyed by `${backend}:${threadId}`.
   */
  private readonly pendingQueueAuditMessages = new Map<
    string,
    PendingQueueAuditMessage
  >();

  constructor(private readonly options: MessagingControllerOptions) {
    this.authorizedActorIds = new Set(options.authorizedActorIds);
    this.capabilityProfile = options.adapter.capabilityProfile;
    this.now = options.now ?? Date.now;
    this.pendingIntentTtlMs =
      options.pendingIntentTtlMs ?? DEFAULT_PENDING_INTENT_TTL_MS;
    this.interactionMapper = options.interactionMapper ?? new DeterministicInteractionMapper();
    this.logger = options.logger ?? messagingControllerLog;
    this.turnAdmission = new MessagingTurnAdmission({
      debounceMs: options.inputDebounceMs ?? DEFAULT_INPUT_DEBOUNCE_MS,
      now: this.now,
      onBundleReady: async (bundle) => {
        await this.handleAdmittedTurnBundle(bundle);
      },
    });
    this.toolUpdatePolicy = new MessagingToolUpdatePolicy({
      now: this.now,
      onBatchReady: async (delivery) => {
        await this.deliverToolUpdateDelivery(delivery);
      },
    });
  }

  async handleInboundEvent(event: MessagingInboundEvent): Promise<void> {
    if (!this.isAuthorized(event.actor.platformUserId)) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("unauthorized"),
          createdAt: this.now(),
          title: "Not authorized",
          body: "This channel user is not authorized to control PwrAgent.",
          recoverable: false,
        }),
        undefined,
        event,
      );
      return;
    }

    // Self-heal: every inbound event carries the freshest ancestry data
    // the adapter knows (parentTitle = supergroup/server, ancestorTitle
    // = guild for Discord threads). Merge any new fields into the
    // stored binding so the renderer's binding chip can show full
    // breadcrumbs without waiting for an explicit refresh.
    //
    // Best-effort: a sqlite hiccup here must not abort the inbound kind
    // dispatch below — the binding refresh is observability/UX, not the
    // source of truth for routing. Log and continue.
    try {
      await this.refreshBindingFromInbound(event);
    } catch (error) {
      this.logger.debug?.("messaging binding refresh failed", {
        eventId: event.id,
        platform: event.channel.channel,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (event.kind === "command") {
      await this.handleCommand(event);
      return;
    }

    if (event.kind === "callback") {
      await this.handleCallback(event);
      return;
    }

    if (event.kind === "media") {
      await this.handleMedia(event);
      return;
    }

    if (event.kind === "text") {
      await this.handleText(event);
    }
  }

  async handleBackendEvent(event: AgentEvent): Promise<void> {
    const threadId = threadIdForBackendEvent(event);
    if (!threadId) {
      return;
    }
    if (event.notification.method === "serverRequest/resolved") {
      await this.handleBackendRequestResolved(event);
      return;
    }
    const queuedParams = readExecutionModeQueuedParams(event.notification);
    if (queuedParams) {
      await this.handleExecutionModeQueued(event.backend, queuedParams);
      await this.refreshStatusSurfacesForThread(
        event.backend,
        threadId,
        event.notification.method,
      );
      return;
    }
    const queueClearedParams = readExecutionModeQueueClearedParams(event.notification);
    if (queueClearedParams) {
      await this.handleExecutionModeQueueCleared(event.backend, queueClearedParams);
      await this.refreshStatusSurfacesForThread(
        event.backend,
        threadId,
        event.notification.method,
      );
      return;
    }
    if (
      event.notification.method === "thread/executionMode/updated" ||
      event.notification.method === "thread/modelSettings/updated"
    ) {
      await this.refreshStatusSurfacesForThread(
        event.backend,
        threadId,
        event.notification.method,
      );
      return;
    }

    const bindings = this.filterBindingsForChannel(
      await this.options.store.findActiveBindingsForThread({
        backend: event.backend,
        threadId,
      }),
    );
    const lifecycle = turnLifecycleForBackendEvent(event, this.now());
    for (const binding of bindings) {
      let activeTurn = this.getActiveTurn(binding);
      let turnStateChanged = false;
      if (lifecycle) {
        const previousTurn = activeTurn;
        activeTurn = lifecycle;
        turnStateChanged = !isSameActiveTurnState(previousTurn, activeTurn);
        if (turnStateChanged) {
          this.setActiveTurn(binding, activeTurn);
          this.logBindingTurnStateChange(
            binding,
            previousTurn,
            activeTurn,
            event.notification.method,
          );
        }
      } else if (isThreadStatusIdleEvent(event) && activeTurn) {
        const previousTurn = activeTurn;
        activeTurn = {
          ...activeTurn,
          status: "completed",
          updatedAt: this.now(),
        };
        turnStateChanged = !isSameActiveTurnState(previousTurn, activeTurn);
        if (turnStateChanged) {
          this.setActiveTurn(binding, activeTurn);
          this.logBindingTurnStateChange(
            binding,
            previousTurn,
            activeTurn,
            event.notification.method,
          );
        }
      }

      await this.deliverToolActivityForBackendEvent(
        event,
        binding,
        activeTurn?.turnId,
      );
      if (
        turnStateChanged &&
        (isTerminalTurnLifecycle(lifecycle) ||
          (isThreadStatusIdleEvent(event) && activeTurn))
      ) {
        await this.flushToolUpdatesForBinding(binding, {
          clear: true,
          turnId: turnIdForBackendEvent(event) ?? activeTurn?.turnId,
        });
      }

      const assistantDelta = assistantDeltaForBackendEvent(event);
      if (assistantDelta) {
        await this.deliverAssistantStreamUpdate(assistantDelta, binding);
      }

      const assistantText = assistantTextForBackendEvent(event);
      if (assistantText) {
        const deliveredFinalStream = await this.flushAssistantStreamForEvent(
          event,
          binding,
          assistantText,
        );
        if (deliveredFinalStream) {
          this.markAssistantMessageDelivered(event, assistantText);
        } else {
          await this.deliverAssistantMessage(assistantText, event, binding);
        }
      } else if (isTerminalTurnLifecycle(activeTurn)) {
        await this.waitForAssistantStreamDeliveriesForEvent(event, binding);
        this.clearAssistantStreamsForEvent(event, binding);
      }

      if (isThreadNameUpdatedEvent(event)) {
        await this.renderBindingStatus(binding);
        continue;
      }

      if (turnStateChanged && (lifecycle || (isThreadStatusIdleEvent(event) && activeTurn))) {
        await this.signalTurnActivity(binding, activeTurn!, {
          reason: event.notification.method,
          force: true,
        });
        await this.renderBindingStatus(binding);
        await this.startNextQueuedTurn(binding);
      } else if (activeTurn?.status === "waiting" && isTurnWorkActivityEvent(event, activeTurn)) {
        const previousTurn = activeTurn;
        activeTurn = {
          ...activeTurn,
          status: "working",
          updatedAt: this.now(),
        };
        this.setActiveTurn(binding, activeTurn);
        this.logBindingTurnStateChange(
          binding,
          previousTurn,
          activeTurn,
          event.notification.method,
        );
        await this.signalTurnActivity(binding, activeTurn, {
          reason: event.notification.method,
          force: true,
        });
        await this.renderBindingStatus(binding);
      } else {
        const latestActiveTurn = this.getActiveTurn(binding);
        if (latestActiveTurn?.status !== "working") {
          continue;
        }
        const eventTurnId = turnIdForBackendEvent(event);
        if (eventTurnId && latestActiveTurn.turnId !== eventTurnId) {
          continue;
        }
        await this.signalTurnActivity(binding, latestActiveTurn, {
          reason: event.notification.method,
        });
      }
    }
  }

  async handleBackendPendingRequest(
    backend: AppServerBackendKind,
    request: AppServerPendingRequestNotification,
  ): Promise<void> {
    const bindings = this.filterBindingsForChannel(
      await this.options.store.findActiveBindingsForThread({
        backend,
        threadId: request.params.threadId,
      }),
    );

    for (const binding of bindings) {
      const intent = this.intentForPendingRequest(request);
      if (!intent) {
        continue;
      }
      intent.bindingId = binding.id;
      intent.requestContext = {
        backend,
        method: request.method,
        requestId: request.params.requestId,
        threadId: request.params.threadId,
        turnId: request.params.turnId ?? undefined,
      };
      intent.audit = buildMessagingAuditContext({
        action: "pending_request.presented",
        actor: {
          platformUserId: binding.authorizedActorIds[0] ?? "unknown",
        },
        backend,
        bindingId: binding.id,
        channel: binding.channel,
        now: this.now(),
        threadId: request.params.threadId,
      });
      const pendingIntent = await this.storePendingIntent(intent, binding);
      const delivery = await this.deliver(intent, binding);
      if (delivery.surface) {
        await this.options.store.upsertPendingIntent({
          ...pendingIntent,
          surface: delivery.surface,
        });
      }
      if (request.params.turnId) {
        const activeTurn: MessagingActiveTurnSummary = {
          turnId: request.params.turnId,
          status: "waiting",
          updatedAt: this.now(),
        };
        this.setActiveTurn(binding, activeTurn);
        await this.signalTurnActivity(binding, activeTurn, {
          force: true,
        });
        await this.renderBindingStatus(binding);
      }
    }
  }

  /**
   * Self-heal stored bindings from the freshest data on every inbound.
   * The adapter populates `parentTitle` / `ancestorTitle` (supergroup
   * / server / channel breadcrumbs) on every inbound channel ref;
   * legacy bindings stored before those fields existed don't have
   * them. Merge in any new fields the binding doesn't already have so
   * the navigation snapshot's binding chip can render full
   * breadcrumbs without waiting for an explicit unbind/rebind.
   */
  private async refreshBindingFromInbound(
    event: MessagingInboundEvent,
  ): Promise<void> {
    const binding = await this.options.store.findActiveBindingForChannel(
      event.channel,
    );
    if (!binding) return;
    const stored = binding.channel.conversation;
    const incoming = event.channel.conversation;
    // Incoming wins when present. Adapters fetch fresher metadata
    // than we stored at bind time:
    //   - Discord resolves channel/parent/guild names via REST every
    //     inbound (bounded LRU cache), so a server or channel rename
    //     reaches us on the next message.
    //   - Telegram caches forum-topic names from `forum_topic_created`
    //     and `forum_topic_edited` service messages, so renames done
    //     in the Telegram client propagate to subsequent inbound
    //     messages.
    // When `incoming` doesn't carry a field (e.g. a regular Telegram
    // topic message that doesn't ship the topic name and the cache
    // missed), we fall back to `stored` so we never lose data we
    // already have.
    //
    // Loop safety: the `if (!changed)` guard below means an inbound
    // whose values match what's stored produces no write and no
    // broadcast — so the gateway echo of our own `editForumTopic`
    // call (which carries the same name we just wrote in
    // `syncConversationName`) is a no-op, not a refresh storm.
    const merged = {
      ...stored,
      title: incoming.title ?? stored.title,
      parentTitle: incoming.parentTitle ?? stored.parentTitle,
      ancestorTitle: incoming.ancestorTitle ?? stored.ancestorTitle,
    };
    const changed =
      merged.title !== stored.title
      || merged.parentTitle !== stored.parentTitle
      || merged.ancestorTitle !== stored.ancestorTitle;
    if (!changed) return;
    await this.options.store.upsertBinding({
      ...binding,
      channel: { ...binding.channel, conversation: merged },
      updatedAt: this.now(),
    });
    // The chip now has fresher breadcrumbs in the store; nudge the
    // renderer to refetch so the tooltip / label reflect them.
    this.notifyBindingChanged("refresh-from-inbound");
  }

  private async handleCommand(event: MessagingInboundCommandEvent): Promise<void> {
    const verb = matchMessagingCommandVerb(event.command);
    if (verb === "status") {
      await this.presentStatus(event);
      return;
    }
    if (verb === "detach") {
      await this.detachBinding(event);
      return;
    }
    if (verb === "resume") {
      await this.presentResumeBrowser(event);
      return;
    }
    // `verb === "help"` and any unrecognized command both fall
    // through to the help surface. For unknown commands this serves
    // as a "did you mean?" prompt with the canonical list.
    await this.presentHelp(event);
  }

  /**
   * Render the help surface. The body is the prose
   * description-list (derived from `MESSAGING_COMMAND_CATALOG` so it
   * never drifts from the verb set) and the action row is one
   * `command:<verb>` button per catalog entry on the current page,
   * plus Prev/Next/Cancel navigation when the catalog overflows a
   * single page.
   *
   * Pagination is stateless: the next/previous page index travels in
   * `action.value.pageIndex` and comes back through the
   * `MessagingInboundCallbackEvent.value` field. Help has no
   * persistent session record like the resume browser does — the
   * page content is deterministic from the catalog plus the page
   * index.
   *
   * Re-renders pass `targetSurface` from the originating callback's
   * interaction state so we update the existing post in place
   * instead of stacking new help posts on every Next click.
   */
  private async presentHelp(
    event: MessagingInboundEvent,
    options?: { pageIndex?: number; targetSurface?: MessagingSurfaceRef },
  ): Promise<void> {
    const page = paginateHelpCatalog({
      profile: this.capabilityProfile,
      pageIndex: options?.pageIndex,
    });
    const actions = buildHelpActions({ page });
    const titleSuffix
      = page.totalPages > 1
        ? ` (page ${page.pageIndex + 1}/${page.totalPages})`
        : "";
    await this.deliver(
      buildConfirmationIntent({
        id: this.newIntentId("help"),
        capabilityProfile: this.capabilityProfile,
        createdAt: this.now(),
        title: `PwrAgent commands${titleSuffix}`,
        body: formatMessagingCommandHelpBody(),
        actions,
        ...(options?.targetSurface
          ? {
              targetSurface: options.targetSurface,
              delivery: { mode: "update" as const, replaceMarkup: true },
            }
          : {}),
      }),
      undefined,
      event,
    );
  }

  private async handleText(event: MessagingInboundTextEvent): Promise<void> {
    const command = parseTextCommand(event.text);
    if (command) {
      await this.handleCommand({
        ...event,
        kind: "command",
        command,
        args: parseTextCommandArgs(event.text),
        rawText: event.text,
      });
      return;
    }

    const pendingIntent = await this.options.store.findActivePendingIntentForChannel({
      actorId: event.actor.platformUserId,
      channel: event.channel,
      now: this.now(),
    });
    if (pendingIntent) {
      const mapped = await this.interactionMapper.mapText({
        intent: pendingIntent.intent,
        text: event.text,
      });
      if (mapped.kind === "matched") {
        await this.handleCallback({
          ...event,
          kind: "callback",
          interaction: {
            channel: event.channel.channel,
            id: mapped.action.id,
          },
          actionId: mapped.action.id,
          value: mapped.action.value,
        });
        return;
      }
      if (mapped.kind === "ambiguous") {
        await this.deliver(
          buildConfirmationIntent({
            id: this.newIntentId("ambiguous-reply"),
            capabilityProfile: this.capabilityProfile,
            createdAt: this.now(),
            title: "Choose an option",
            body: pendingIntent.intent.fallbackText ?? "Reply with one of the shown options.",
            fallbackText: pendingIntent.intent.fallbackText,
          }),
          undefined,
          event,
        );
        return;
      }
    }

    const binding = await this.options.store.findActiveBindingForChannel(event.channel);
    if (!binding) {
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("needs-binding"),
          capabilityProfile: this.capabilityProfile,
          createdAt: this.now(),
          title: "Choose a thread",
          body: "Bind this conversation to a PwrAgent thread before sending instructions.",
          fallbackText: "Reply /resume to choose a thread.",
          actions: [
            {
              id: "command:resume",
              label: "Resume",
              style: "primary",
              fallbackText: "/resume",
            },
          ],
        }),
        undefined,
        event,
      );
      return;
    }

    if (isToolsFallbackText(event.text)) {
      await this.cycleToolUpdateMode(binding, event);
      return;
    }

    await this.turnAdmission.append({ binding, event });
  }

  private async handleMedia(event: MessagingInboundMediaEvent): Promise<void> {
    const command = event.text ? parseTextCommand(event.text) : undefined;
    if (command) {
      await this.handleCommand({
        ...event,
        kind: "command",
        command,
        args: parseTextCommandArgs(event.text ?? ""),
        rawText: event.text ?? "",
      });
      return;
    }

    const binding = await this.options.store.findActiveBindingForChannel(event.channel);
    if (!binding) {
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("needs-binding-media"),
          capabilityProfile: this.capabilityProfile,
          createdAt: this.now(),
          title: "Choose a thread",
          body: "Bind this conversation to a PwrAgent thread before sending attachments.",
          fallbackText: "Reply /resume to choose a thread.",
          actions: [
            {
              id: "command:resume",
              label: "Resume",
              style: "primary",
              fallbackText: "/resume",
            },
          ],
        }),
        undefined,
        event,
      );
      return;
    }

    await this.turnAdmission.append({ binding, event });
  }

  private async handleAdmittedTurnBundle(
    bundle: MessagingTurnAdmissionBundle,
  ): Promise<void> {
    const prepared = await this.prepareTurnInput(bundle.events, bundle.binding, bundle.events[0]);
    if (!prepared) {
      return;
    }

    if (await this.isTurnOccupied(bundle.binding, bundle.threadKey)) {
      await this.queuePreparedInput({
        binding: bundle.binding,
        input: prepared.input,
        preview: prepared.preview,
        threadKey: bundle.threadKey,
      });
      return;
    }

    await this.startPreparedInput({
      binding: bundle.binding,
      input: prepared.input,
      preview: prepared.preview,
      threadKey: bundle.threadKey,
      event: bundle.events[0],
    });
  }

  private async prepareTurnInput(
    events: MessagingTurnInputEvent[],
    binding: MessagingBindingRecord,
    event?: MessagingInboundEvent,
  ): Promise<
    | {
        input: AppServerTurnInputItem[];
        preview: string;
      }
    | undefined
  > {
    const input: AppServerTurnInputItem[] = [];
    const previewParts: string[] = [];
    const rejections: MessagingAttachmentRejection[] = [];

    for (const turnEvent of events) {
      if (turnEvent.kind === "text") {
        const previewText = turnEvent.text.trim();
        if (previewText) {
          input.push({ type: "text", text: turnEvent.text });
          previewParts.push(previewText);
        }
        continue;
      }

      const processed = await processMessagingAttachments({
        adapter: this.options.adapter,
        attachments: turnEvent.attachments,
        policy: {
          ...DEFAULT_MESSAGING_ATTACHMENT_POLICY,
          ...this.options.attachmentPolicy,
        },
        text: turnEvent.text,
      });

      input.push(...processed.input);
      rejections.push(...processed.rejections);
      if (turnEvent.text?.trim()) {
        previewParts.push(turnEvent.text.trim());
      }
      for (const attachment of turnEvent.attachments) {
        previewParts.push(`[${attachment.name}]`);
      }
    }

    if (input.length === 0) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("unsupported-media"),
          createdAt: this.now(),
          title: "Attachment not supported",
          body:
            rejections.length > 0
              ? formatAttachmentRejections(rejections)
              : "This attachment could not be prepared for the model.",
          recoverable: true,
        }),
        binding,
        event,
      );
      return undefined;
    }

    if (rejections.length > 0) {
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("attachment-partial"),
          capabilityProfile: this.capabilityProfile,
          createdAt: this.now(),
          title: "Some attachments were skipped",
          body: formatAttachmentRejections(rejections),
        }),
        binding,
        event,
      );
    }

    return {
      input,
      preview: buildQueuedInputPreview(previewParts),
    };
  }

  private async startPreparedInput(params: {
    binding: MessagingBindingRecord;
    event?: MessagingInboundEvent;
    input: AppServerTurnInputItem[];
    preview: string;
    queueOnConcurrentStart?: boolean;
    threadKey: string;
  }): Promise<boolean> {
    this.turnAdmission.markStarting(params.threadKey);
    let turnStarted = false;

    try {
      const navigation = await this.options.backend.getNavigationSnapshot({
        backend: "all",
      });
      const turnSettings = turnSettingsForBinding(params.binding, navigation);
      const executionResolution = resolveExecutionModeForBinding(
        params.binding,
        navigation,
      );
      // Diagnostic for #203-class regressions: a turn that the UI shows
      // as Default Access but routes to the Full Access codex client is
      // a silent security bug — the user thinks they're sandboxed but
      // commands like `npm view` succeed because the full-access client
      // skipped the network sandbox. We log the resolved mode + where
      // it came from here at the messaging layer; the registry's
      // `codex thread client routing` log shows which client actually
      // received the turn. Cross-reference both lines by threadId to
      // verify the routing matched intent. `executionModeSource` of
      // anything other than `thread` is suspicious for a thread the UI
      // claims has been explicitly toggled.
      this.logger.info?.("messaging starting turn", {
        backend: params.binding.backend,
        bindingId: params.binding.id,
        channel: params.binding.channel.channel,
        threadId: params.binding.threadId,
        executionMode: turnSettings.executionMode ?? "unset",
        executionModeSource: executionResolution.source,
        model: turnSettings.model,
        fastMode: turnSettings.fastMode,
      });
      const started = await this.options.backend.startTurn({
        backend: params.binding.backend,
        threadId: params.binding.threadId,
        input: params.input,
        ...turnSettings,
      });
      turnStarted = true;
      this.logger.info?.("messaging turn started", {
        bindingId: params.binding.id,
        threadId: params.binding.threadId,
        turnId: started.turnId,
        requestedExecutionMode: turnSettings.executionMode ?? "unset",
      });
      const activeTurn: MessagingActiveTurnSummary = {
        turnId: started.turnId,
        status: "working",
        startedAt: this.now(),
        updatedAt: this.now(),
      };
      this.setActiveTurn(params.binding, activeTurn);
      await this.signalTurnActivity(params.binding, activeTurn, {
        force: true,
      });
      await this.renderBindingStatus(params.binding, undefined, navigation);
      return true;
    } catch (error) {
      if (turnStarted) {
        this.logger.debug?.("messaging post-start update failed", {
          error: error instanceof Error ? error.message : String(error),
          threadId: params.binding.threadId,
        });
        return true;
      }
      if (isTurnInProgressStartError(error)) {
        if (params.queueOnConcurrentStart !== false) {
          await this.queuePreparedInput({
            binding: params.binding,
            input: params.input,
            preview: params.preview,
            threadKey: params.threadKey,
          });
        }
        return false;
      }
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("turn-start-failed"),
          createdAt: this.now(),
          title: "Turn could not start",
          body: error instanceof Error ? error.message : String(error),
          recoverable: true,
        }),
        params.binding,
        params.event,
      );
      return false;
    } finally {
      this.turnAdmission.clearStarting(params.threadKey);
    }
  }

  private async isTurnOccupied(
    binding: MessagingBindingRecord,
    threadKey: string,
  ): Promise<boolean> {
    if (this.turnAdmission.isStarting(threadKey)) {
      return true;
    }

    const activeTurn = this.getActiveTurn(binding);
    if (activeTurn && ["working", "waiting"].includes(activeTurn.status)) {
      return true;
    }

    if (!this.options.backend.readThreadStatus) {
      return false;
    }

    const threadStatus = await this.options.backend.readThreadStatus({
      backend: binding.backend,
      threadId: binding.threadId,
    });
    return threadStatus === "active";
  }

  private async queuePreparedInput(params: {
    binding: MessagingBindingRecord;
    input: AppServerTurnInputItem[];
    preview: string;
    threadKey: string;
  }): Promise<void> {
    const queued = this.turnAdmission.enqueue(params);
    await this.deliverQueuedTurnNotice(queued);
  }

  private async deliverQueuedTurnNotice(entry: MessagingQueuedTurnEntry): Promise<void> {
    const canSteer = this.canSteerQueuedTurn(entry);
    const intent = buildConfirmationIntent({
      id: this.newIntentId("queued-turn"),
      capabilityProfile: this.capabilityProfile,
      createdAt: this.now(),
      title: "Message queued",
      body: buildQueuedTurnNoticeBody(entry.preview, canSteer),
      actions: [
        {
          id: `queued-turn:steer:${entry.id}`,
          label: "Steer",
          style: "primary",
          disabled: !canSteer,
        },
        {
          id: `queued-turn:cancel:${entry.id}`,
          label: "Cancel",
          style: "secondary",
        },
      ],
    });
    const result = await this.deliver(intent, entry.binding);
    if (result.surface) {
      this.turnAdmission.updateQueuedEntry(entry, {
        surface: result.surface,
      });
    }
  }

  private canSteerQueuedTurn(entry: MessagingQueuedTurnEntry): boolean {
    const activeTurn = this.getActiveTurn(entry.binding);
    return Boolean(
      this.options.backend.steerTurn &&
        activeTurn &&
        ["working", "waiting"].includes(activeTurn.status),
    );
  }

  private async retireQueuedTurnNotice(
    entry: MessagingQueuedTurnEntry,
    body: string,
    event?: MessagingInboundCallbackEvent,
  ): Promise<void> {
    const targetSurface = entry.surface ?? event?.interaction;
    if (!targetSurface) {
      return;
    }

    try {
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("queued-turn-retired"),
          capabilityProfile: this.capabilityProfile,
          createdAt: this.now(),
          delivery: {
            mode: "update",
            replaceMarkup: true,
            fallback: "present_new",
          },
          title: "Message queued",
          body,
          targetSurface,
        }),
        entry.binding,
        event,
      );
    } catch (error) {
      this.logger.debug?.("messaging queued turn notice retirement failed", {
        error: error instanceof Error ? error.message : String(error),
        queuedTurnId: entry.id,
      });
    }
  }

  private async handleQueuedTurnCallback(
    event: MessagingInboundCallbackEvent,
    action: QueuedTurnAction,
  ): Promise<void> {
    const entry = this.turnAdmission.findQueuedEntry(action.entryId);
    if (!entry || entry.status !== "queued") {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("expired-queued-turn"),
          createdAt: this.now(),
          title: "Queued message unavailable",
          body: "That queued message is no longer waiting.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    if (action.kind === "cancel") {
      const cancelled = this.turnAdmission.updateQueuedEntry(entry, {
        status: "cancelled",
      });
      await this.retireQueuedTurnNotice(
        cancelled,
        "Queued message cancelled.",
        event,
      );
      return;
    }

    const activeTurn = this.getActiveTurn(entry.binding);
    if (
      !this.options.backend.steerTurn ||
      !activeTurn ||
      !["working", "waiting"].includes(activeTurn.status)
    ) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("queued-turn-steer-unavailable"),
          createdAt: this.now(),
          title: "Steer unavailable",
          body: "There is no active turn available to steer. The message is still queued.",
          recoverable: true,
        }),
        entry.binding,
        event,
      );
      return;
    }

    try {
      await this.options.backend.steerTurn({
        backend: entry.binding.backend,
        threadId: entry.binding.threadId,
        expectedTurnId: activeTurn.turnId,
        input: entry.input,
      });
    } catch (error) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("queued-turn-steer-failed"),
          createdAt: this.now(),
          title: "Steer failed",
          body: `${
            error instanceof Error ? error.message : String(error)
          }\n\nThe message is still queued.`,
          recoverable: true,
        }),
        entry.binding,
        event,
      );
      return;
    }
    const steered = this.turnAdmission.updateQueuedEntry(entry, {
      status: "steered",
    });
    await this.retireQueuedTurnNotice(
      steered,
      "Queued message was sent as a steering message.",
      event,
    );
  }

  private async startNextQueuedTurn(binding: MessagingBindingRecord): Promise<void> {
    const threadKey = this.threadKeyForBinding(binding);
    if (await this.isTurnOccupied(binding, threadKey)) {
      return;
    }

    const entry = this.turnAdmission.peekNextQueued(threadKey);
    if (!entry) {
      return;
    }

    const started = await this.startPreparedInput({
      binding: entry.binding,
      input: entry.input,
      preview: entry.preview,
      queueOnConcurrentStart: false,
      threadKey,
    });
    if (!started) {
      return;
    }

    const submitted = this.turnAdmission.updateQueuedEntry(entry, {
      status: "submitted",
    });
    this.turnAdmission.removeQueuedEntry(submitted);
    await this.retireQueuedTurnNotice(
      submitted,
      "Queued message sent as the next turn.",
    );
  }

  private async handleCallback(event: MessagingInboundCallbackEvent): Promise<void> {
    const command = readCommandAction(event);
    if (command) {
      await this.handleCommand({
        ...event,
        kind: "command",
        args: [],
        command,
        rawText: `/${command}`,
      });
      return;
    }

    const helpAction = readHelpNavAction(event);
    if (helpAction) {
      await this.handleHelpNavCallback(event, helpAction);
      return;
    }

    const browseAction = readBrowseAction(event);
    if (browseAction) {
      await this.handleBrowseCallback(event, browseAction);
      return;
    }

    const permissionsQueueCancelAction = readPermissionsQueueCancelAction(event);
    if (permissionsQueueCancelAction) {
      await this.handlePermissionsQueueCancelCallback(
        event,
        permissionsQueueCancelAction.queueId,
      );
      return;
    }

    const statusAction = readStatusAction(event);
    if (statusAction) {
      await this.handleStatusCallback(event, statusAction);
      return;
    }

    const queuedTurnAction = readQueuedTurnAction(event);
    if (queuedTurnAction) {
      await this.handleQueuedTurnCallback(event, queuedTurnAction);
      return;
    }

    const bindingTarget = readBindingTarget(event);
    if (bindingTarget) {
      const binding = await this.bindChannelToThread(event, bindingTarget);
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("bound"),
          capabilityProfile: this.capabilityProfile,
          createdAt: this.now(),
          title: "Thread bound",
          body: "Messages in this conversation will route to the selected thread.",
          fallbackText: "Send a message to continue the thread.",
        }),
        binding,
      );
      await this.renderBindingStatus(binding);
      return;
    }

    const pendingIntent = await this.options.store.findActivePendingIntentForChannel({
      actorId: event.actor.platformUserId,
      channel: event.channel,
      now: this.now(),
    });
    if (pendingIntent) {
      const action = actionsForIntent(pendingIntent.intent).find(
        (candidate) => candidate.id === (event.actionId ?? event.interaction.id),
      );
      if (action && pendingIntent.intent.kind === "approval") {
        await this.submitApprovalAction(pendingIntent.intent, action.id);
        await this.retireApprovalIntent(pendingIntent, event);
        await this.options.store.deletePendingIntent(pendingIntent.id);
        const resumedBinding = await this.resumeBindingForPendingIntent(
          pendingIntent,
          "pending_request.submitted",
        );
        if (resumedBinding) {
          await this.renderBindingStatus(resumedBinding, event);
        }
        await this.deliver(
          buildStatusIntent({
            id: this.newIntentId("approval-submitted"),
            createdAt: this.now(),
            status: "completed",
            text: "Approval response sent.",
          }),
          undefined,
          event,
        );
        return;
      }
    }

    if ((event.actionId ?? event.interaction.id).startsWith("approval:")) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("expired-approval"),
          createdAt: this.now(),
          title: "Approval expired",
          body: "That approval request is no longer available. Retry the command or request that needed approval.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    await this.deliver(
      buildErrorIntent({
        id: this.newIntentId("expired-callback"),
        createdAt: this.now(),
        title: "Action expired",
        body: "That action is no longer available. Use /resume to refresh.",
        recoverable: true,
      }),
      undefined,
      event,
    );
  }

  private async submitApprovalAction(
    intent: Extract<MessagingSurfaceIntent, { kind: "approval" }>,
    actionId: string,
  ): Promise<void> {
    const requestContext = intent.requestContext;
    const decision = intent.decisions.find((action) => action.id === actionId)?.decision;
    if (!requestContext || !decision || !this.options.backend.submitServerRequest) {
      return;
    }

    await this.options.backend.submitServerRequest({
      backend: requestContext.backend,
      threadId: requestContext.threadId,
      turnId: requestContext.turnId,
      requestId: requestContext.requestId,
      response: {
        decision,
      },
    });
  }

  /**
   * Re-render status surfaces for every binding tied to a thread on this
   * controller's channel. Used by the thread-state update bus to fan out
   * cross-surface refreshes when state changes anywhere — desktop UI,
   * Telegram callback, Discord callback — so every surface reflects the new
   * value. The reason is logged for audit only.
   */
  private async refreshStatusSurfacesForThread(
    backend: AppServerBackendKind,
    threadId: ThreadIdentifier,
    reason: string,
  ): Promise<void> {
    const bindings = this.filterBindingsForChannel(
      await this.options.store.findActiveBindingsForThread({
        backend,
        threadId,
      }),
    );
    const renderableBindings = bindings.filter(
      (binding) => binding.statusSurface || binding.pinnedStatusSurface,
    );
    if (renderableBindings.length === 0) {
      return;
    }
    // Fetch the navigation snapshot once and reuse it across every binding's
    // render. Without this, each renderBindingStatus call would issue its own
    // getNavigationSnapshot — N bindings on the same thread = N redundant
    // backend calls.
    const navigation = await this.options.backend.getNavigationSnapshot({
      backend: "all",
    });
    for (const binding of renderableBindings) {
      try {
        await this.renderBindingStatus(binding, undefined, navigation);
      } catch (error) {
        this.logger.debug?.("messaging status refresh failed", {
          backend,
          bindingId: binding.id,
          error: error instanceof Error ? error.message : String(error),
          reason,
          threadId,
        });
      }
    }
  }

  /**
   * Post a "Permissions queued" audit message in every active binding for
   * the thread, mirroring the desktop transcript audit entry. The
   * registry's `thread/executionMode/queued` notification is the trigger;
   * we resolve from/to mode labels off the navigation snapshot at the
   * time the notification fires.
   */
  private async handleExecutionModeQueued(
    backend: AppServerBackendKind,
    params: {
      threadId: ThreadIdentifier;
      queuedExecutionMode: ThreadExecutionMode;
      queuedAt: number;
    },
  ): Promise<void> {
    const bindings = this.filterBindingsForChannel(
      await this.options.store.findActiveBindingsForThread({
        backend,
        threadId: params.threadId,
      }),
    );
    if (bindings.length === 0) {
      return;
    }

    const navigation = await this.options.backend.getNavigationSnapshot({
      backend: "all",
    });
    const thread = navigation.threads.find(
      (candidate) =>
        candidate.source === backend && candidate.id === params.threadId,
    );
    const fromExecutionMode = thread?.executionMode ?? "default";
    const toExecutionMode = params.queuedExecutionMode;

    // The registry's queueCleared notification doesn't carry the queueId
    // back, so we generate the cancel-action id here from the bus event.
    // The registry's cancelThreadExecutionModeQueue is idempotent — extra
    // clicks (or stale buttons) cancel the *current* queue or no-op if
    // nothing is pending. The id encoded here is for human/log
    // observability and to namespace per-queue cancel taps.
    const queueKey = this.queueAuditKey(backend, params.threadId);
    const queueId = `${params.threadId}:${params.queuedAt}`;

    const intent: MessagingConfirmationIntent = buildConfirmationIntent({
      id: this.newIntentId("permissions-queue"),
      capabilityProfile: this.capabilityProfile,
      createdAt: this.now(),
      title: "⏳ Permissions queue",
      body: [
        `${formatExecutionModeLabel(fromExecutionMode)} → ${formatExecutionModeLabel(toExecutionMode)}`,
        "Will apply at end of current turn.",
      ].join("\n"),
      fallbackText: "Reply Cancel to drop the queued change.",
      actions: [
        {
          id: `${PERMISSIONS_QUEUE_CANCEL_ACTION_PREFIX}${queueId}`,
          label: "Cancel",
          fallbackText: "cancel",
          style: "danger",
          priority: 1,
        },
      ],
    });

    const tracking: PendingQueueAuditMessage = {
      backend,
      threadId: params.threadId,
      queueId,
      fromExecutionMode,
      toExecutionMode,
      queuedAt: params.queuedAt,
      surfaces: new Map(),
    };

    for (const binding of bindings) {
      try {
        const result = await this.deliver({ ...intent }, binding);
        if (result.surface && result.outcome !== "failed") {
          tracking.surfaces.set(binding.id, result.surface);
        }
      } catch (error) {
        this.logger.debug?.("messaging permissions-queue audit deliver failed", {
          bindingId: binding.id,
          threadId: params.threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (tracking.surfaces.size > 0) {
      this.pendingQueueAuditMessages.set(queueKey, tracking);
    }
  }

  /**
   * Edit (or, on edit failure, repost) the previously-stored "queued"
   * audit message to reflect the new state — `cancelled` or
   * `applied`. Idempotent on missing tracking state (a queue cleared
   * before we ever managed to post the message has nothing to update).
   */
  private async handleExecutionModeQueueCleared(
    backend: AppServerBackendKind,
    params: {
      threadId: ThreadIdentifier;
      reason: "applied" | "cancelled";
    },
  ): Promise<void> {
    const queueKey = this.queueAuditKey(backend, params.threadId);
    const tracking = this.pendingQueueAuditMessages.get(queueKey);
    // Diagnostic: surface counts and edit outcomes so we can trace
    // "Cancel button still showing after apply" reports — if the
    // edit silently fails (Telegram message-too-old, network blip,
    // adapter not honoring replaceMarkup), the previously-stored
    // surface stays visible with its button until next refresh.
    this.logger.debug?.(
      "messaging permissions-queue clearance",
      {
        backend,
        threadId: params.threadId,
        reason: params.reason,
        hasTracking: !!tracking,
        surfaceCount: tracking?.surfaces.size ?? 0,
        queueId: tracking?.queueId,
      },
    );
    if (!tracking) {
      return;
    }

    const fromLabel = formatExecutionModeLabel(tracking.fromExecutionMode);
    const toLabel = formatExecutionModeLabel(tracking.toExecutionMode);
    const body =
      params.reason === "cancelled"
        ? `✕ Cancelled queued permissions change (${fromLabel} → ${toLabel})`
        : `🔓 Permissions changed: ${fromLabel} → ${toLabel} at ${formatTimeOfDay(this.now())} (submitted)`;
    const title =
      params.reason === "cancelled"
        ? "Permissions queue cancelled"
        : "Permissions changed";

    for (const [bindingId, surface] of tracking.surfaces) {
      const binding = await this.options.store.getBinding(bindingId);
      if (!binding || binding.revokedAt) {
        continue;
      }
      const intent: MessagingConfirmationIntent = buildConfirmationIntent({
        id: this.newIntentId("permissions-queue-cleared"),
        capabilityProfile: this.capabilityProfile,
        createdAt: this.now(),
        title,
        body,
        // Edit the existing queued message in place; on edit failure
        // (message gone, too old, edit not supported) the adapter's
        // `present_new` fallback posts a fresh message instead. This
        // mirrors the 2026-04-30-002 messaging-command-surfaces edit
        // failure pattern.
        delivery: {
          mode: "update",
          replaceMarkup: true,
          fallback: "present_new",
        },
        targetSurface: surface,
        // Empty actions array — buttons removed on resolve.
        actions: [],
        fallbackText: body,
      });
      try {
        const result = await this.deliver(intent, binding);
        this.logger.debug?.(
          "messaging permissions-queue audit edit",
          {
            bindingId: binding.id,
            threadId: params.threadId,
            reason: params.reason,
            outcome: result.outcome,
            // If outcome is "presented_new" the adapter posted a
            // fresh "submitted/cancelled" message but couldn't edit
            // the original. The original message (with its Cancel
            // button) stays visible in the chat — that's the user's
            // observed bug. Stale-tap feedback in
            // handlePermissionsQueueCancelCallback handles the
            // recovery path.
          },
        );
      } catch (error) {
        this.logger.debug?.(
          "messaging permissions-queue audit edit failed",
          {
            bindingId: binding.id,
            threadId: params.threadId,
            reason: params.reason,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }

    this.pendingQueueAuditMessages.delete(queueKey);
  }

  private queueAuditKey(
    backend: AppServerBackendKind,
    threadId: ThreadIdentifier,
  ): string {
    return `${backend}:${threadId}`;
  }

  private async handleBackendRequestResolved(event: AgentEvent): Promise<void> {
    if (event.notification.method !== "serverRequest/resolved") {
      return;
    }

    const pendingIntents =
      await this.options.store.findActivePendingIntentsForRequest({
        backend: event.backend,
        threadId: event.notification.params.threadId,
        requestId: event.notification.params.requestId,
        now: this.now(),
      });

    for (const pendingIntent of pendingIntents.filter((intent) =>
      this.isChannelInScope(intent.channel),
    )) {
      await this.retireApprovalIntent(pendingIntent);
      await this.options.store.deletePendingIntent(pendingIntent.id);
      const resumedBinding = await this.resumeBindingForPendingIntent(
        pendingIntent,
        event.notification.method,
      );
      if (resumedBinding) {
        await this.renderBindingStatus(resumedBinding);
      }
    }
  }

  private async retireApprovalIntent(
    pendingIntent: MessagingPendingIntentRecord,
    event?: MessagingInboundCallbackEvent,
  ): Promise<void> {
    if (pendingIntent.intent.kind !== "approval") {
      return;
    }

    const targetSurface = pendingIntent.surface ?? event?.interaction;
    if (!targetSurface) {
      return;
    }

    try {
      await this.deliver(
        {
          ...pendingIntent.intent,
          decisions: [],
          delivery: {
            mode: "update",
            replaceMarkup: true,
            fallback: "fail",
          },
          targetSurface,
        },
        undefined,
        event,
      );
    } catch (error) {
      this.logger.debug?.("messaging approval retirement update failed", {
        error: error instanceof Error ? error.message : String(error),
        intentId: pendingIntent.intent.id,
      });
    }
  }

  private async resumeBindingForPendingIntent(
    pendingIntent: MessagingPendingIntentRecord,
    reason: string,
  ): Promise<MessagingBindingRecord | undefined> {
    const bindingId = pendingIntent.bindingId;
    const turnId = pendingIntent.intent.requestContext?.turnId;
    if (!bindingId || !turnId) {
      return undefined;
    }

    const binding = await this.options.store.getBinding(bindingId);
    const activeTurn = binding ? this.getActiveTurn(binding) : undefined;
    if (
      !binding ||
      binding.revokedAt ||
      !activeTurn ||
      activeTurn.turnId !== turnId ||
      activeTurn.status !== "waiting"
    ) {
      return undefined;
    }

    const resumedTurn: MessagingActiveTurnSummary = {
      ...activeTurn,
      status: "working",
      updatedAt: this.now(),
    };
    this.setActiveTurn(binding, resumedTurn);
    this.logBindingTurnStateChange(binding, activeTurn, resumedTurn, reason);
    await this.signalTurnActivity(binding, resumedTurn, {
      force: true,
      reason,
    });
    return binding;
  }

  private async deliverAssistantStreamUpdate(
    delta: AssistantStreamDelta,
    binding: MessagingBindingRecord,
  ): Promise<void> {
    const bufferKey = this.assistantStreamBufferKey(delta.streamKey, binding);
    const now = this.now();
    const existing = this.assistantStreamBuffers.get(bufferKey);
    const buffer: AssistantStreamBuffer = existing
      ? {
          ...existing,
          delta: delta.delta,
          sequence: existing.sequence + 1,
          text: `${existing.text}${delta.delta}`,
        }
      : {
          ...delta,
          lastEmittedAt: 0,
          sequence: 1,
          text: delta.delta,
        };
    this.assistantStreamBuffers.set(bufferKey, buffer);

    if (
      buffer.text.trim().length === 0 ||
      (buffer.lastEmittedAt > 0 && now - buffer.lastEmittedAt < STREAM_UPDATE_REFRESH_MS)
    ) {
      return;
    }

    this.assistantStreamBuffers.set(bufferKey, {
      ...buffer,
      lastEmittedAt: now,
    });
    await this.enqueueAssistantStreamBufferDelivery(bufferKey, binding, false);
  }

  private async flushAssistantStreamForEvent(
    event: AgentEvent,
    binding: MessagingBindingRecord,
    finalText: string,
  ): Promise<boolean> {
    let deliveredFinalStream = false;
    for (const bufferKey of this.assistantStreamBufferKeysForEvent(event, binding)) {
      const buffer = this.assistantStreamBuffers.get(bufferKey);
      if (!buffer) {
        continue;
      }
      this.assistantStreamBuffers.set(bufferKey, {
        ...buffer,
        delta: "",
        lastEmittedAt: this.now(),
        sequence: buffer.sequence + 1,
        text: finalText,
      });
      const result = await this.enqueueAssistantStreamBufferDelivery(bufferKey, binding, true);
      deliveredFinalStream ||= isVisibleAssistantStreamDelivery(result);
      this.assistantStreamBuffers.delete(bufferKey);
      this.assistantStreamDeliveryQueues.delete(bufferKey);
    }
    return deliveredFinalStream;
  }

  private clearAssistantStreamsForEvent(
    event: AgentEvent,
    binding: MessagingBindingRecord,
  ): void {
    for (const bufferKey of this.assistantStreamBufferKeysForEvent(event, binding)) {
      this.assistantStreamBuffers.delete(bufferKey);
      this.assistantStreamDeliveryQueues.delete(bufferKey);
    }
  }

  private async waitForAssistantStreamDeliveriesForEvent(
    event: AgentEvent,
    binding: MessagingBindingRecord,
  ): Promise<void> {
    const deliveries = this.assistantStreamBufferKeysForEvent(event, binding)
      .map((bufferKey) => this.assistantStreamDeliveryQueues.get(bufferKey))
      .filter((delivery): delivery is Promise<void> => Boolean(delivery));
    if (deliveries.length === 0) {
      return;
    }
    await Promise.allSettled(deliveries);
  }

  private assistantStreamBufferKeysForEvent(
    event: AgentEvent,
    binding: MessagingBindingRecord,
  ): string[] {
    const keys = new Set(
      assistantStreamKeysForBackendEvent(event).map((streamKey) =>
        this.assistantStreamBufferKey(streamKey, binding),
      ),
    );
    const filter = assistantStreamFilterForBackendEvent(event);
    if (!filter) {
      return [...keys];
    }
    for (const [bufferKey, buffer] of this.assistantStreamBuffers) {
      if (
        bufferKey.startsWith(`${binding.id}\0`) &&
        buffer.streamKey.startsWith(`${event.backend}:`) &&
        buffer.threadId === filter.threadId &&
        (!filter.turnId || buffer.turnId === filter.turnId)
      ) {
        keys.add(bufferKey);
      }
    }
    return [...keys];
  }

  private async enqueueAssistantStreamBufferDelivery(
    bufferKey: string,
    binding: MessagingBindingRecord,
    isFinal: boolean,
  ): Promise<MessagingDeliveryResult> {
    let result: MessagingDeliveryResult | undefined;
    const previous = this.assistantStreamDeliveryQueues.get(bufferKey) ?? Promise.resolve();
    const delivery = previous
      .catch(() => undefined)
      .then(async () => {
        const latest = this.assistantStreamBuffers.get(bufferKey);
        if (!latest) {
          return;
        }
        result = await this.deliverAssistantStreamBuffer(latest, binding, isFinal);
      });
    this.assistantStreamDeliveryQueues.set(bufferKey, delivery);
    try {
      await delivery;
    } finally {
      if (this.assistantStreamDeliveryQueues.get(bufferKey) === delivery) {
        this.assistantStreamDeliveryQueues.delete(bufferKey);
      }
    }
    return result ?? {
      channel: binding.channel.channel,
      deliveredAt: this.now(),
      outcome: "discarded",
    };
  }

  private async deliverAssistantStreamBuffer(
    buffer: AssistantStreamBuffer,
    binding: MessagingBindingRecord,
    isFinal: boolean,
  ): Promise<MessagingDeliveryResult> {
    const now = this.now();
    const intent: MessagingStreamUpdateIntent = {
      id: this.newIntentId(isFinal ? "assistant-stream-final" : "assistant-stream"),
      kind: "stream_update",
      bindingId: binding.id,
      createdAt: now,
      ...(buffer.surface
        ? {
            delivery: {
              mode: "update",
              fallback: "fail",
            },
            targetSurface: buffer.surface,
          }
        : {}),
      role: "assistant",
      markdown: isFinal ? "markdown" : "plain",
      policy: binding.preferences?.streamingResponses ?? "inherit",
      delta: buffer.delta,
      text: buffer.text,
      stream: {
        key: buffer.streamKey,
        turnId: buffer.turnId,
        itemId: buffer.itemId,
        sequence: buffer.sequence,
        isFinal,
      },
    };
    const result = await this.deliver(intent, binding);
    const surface =
      result.surface && isVisibleAssistantStreamDelivery(result)
        ? result.surface
        : buffer.surface;
    const bufferKey = this.assistantStreamBufferKey(buffer.streamKey, binding);
    const current = this.assistantStreamBuffers.get(bufferKey);
    this.assistantStreamBuffers.set(bufferKey, {
      ...(current && current.sequence >= buffer.sequence ? current : buffer),
      lastEmittedAt: now,
      surface,
    });
    return result;
  }

  private assistantStreamBufferKey(
    streamKey: string,
    binding: MessagingBindingRecord,
  ): string {
    return `${binding.id}\0${streamKey}`;
  }

  private async deliverAssistantMessage(
    text: string,
    event: AgentEvent,
    binding: MessagingBindingRecord,
  ): Promise<void> {
    if (!this.markAssistantMessageDelivered(event, text)) {
      return;
    }
    this.logger.debug?.(
      `messaging assistant deliver thread=${binding.threadId} binding=${binding.id} chars=${text.length} preview="${compactLogPreview(text)}"`,
    );

    await this.deliver(
      {
        id: this.newIntentId("assistant-message"),
        kind: "message",
        bindingId: binding.id,
        createdAt: this.now(),
        role: "assistant",
        parts: [
          {
            type: "text",
            text,
            markdown: "markdown",
          },
        ],
      },
      binding,
    );
  }

  private markAssistantMessageDelivered(event: AgentEvent, text: string): boolean {
    const key = assistantMessageDeliveryKey(event, text);
    if (this.deliveredAssistantMessageKeys.has(key)) {
      return false;
    }
    this.deliveredAssistantMessageKeys.add(key);
    return true;
  }

  dispose(): void {
    this.turnAdmission.dispose();
    this.toolUpdatePolicy.dispose();
  }

  /**
   * Handle navigation callbacks on the paginated help surface
   * (Prev / Next / Cancel). The page index travels in
   * `event.value.pageIndex` so help has no persistent session
   * record — re-rendering is a function of catalog + page index.
   *
   * `targetSurface` is taken from the originating callback's
   * interaction state so the help post is updated in place rather
   * than stacking new posts on every Next click.
   */
  private async handleHelpNavCallback(
    event: MessagingInboundCallbackEvent,
    actionId: string,
  ): Promise<void> {
    const targetSurface: MessagingSurfaceRef | undefined = {
      channel: event.interaction.channel,
      id: event.interaction.id,
      ...(event.interaction.state ? { state: event.interaction.state } : {}),
    };
    if (actionId === "help:cancel") {
      // Replace the help body with a brief dismissal and strip the
      // action row. Mirrors the resume browser's "Resume cancelled"
      // pattern for consistent dismissed-surface UX across both
      // paginated flows.
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("help-dismissed"),
          capabilityProfile: this.capabilityProfile,
          createdAt: this.now(),
          title: "Help dismissed",
          body: "Send `/help` or `@<bot> help` to see commands again.",
          actions: [],
          delivery: { mode: "update", replaceMarkup: true },
          targetSurface,
        }),
        undefined,
        event,
      );
      return;
    }
    const requestedPage = readHelpPageIndex(event);
    await this.presentHelp(event, {
      pageIndex: requestedPage,
      targetSurface,
    });
  }

  private async presentResumeBrowser(event: MessagingInboundCommandEvent): Promise<void> {
    const parsed = parseResumeCommandArgs(event.args);
    if (parsed.error) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("resume-error"),
          createdAt: this.now(),
          title: "Resume command error",
          body: parsed.error,
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    const navigation = await this.options.backend.getNavigationSnapshot({
      backend: "all",
      filter: parsed.query,
    });
    const selectedDirectory = parsed.cwd
      ? navigation.directories.find(
          (directory) => directory.path === parsed.cwd || directory.key === parsed.cwd,
        )
      : undefined;
    const session: MessagingBrowseSessionRecord = {
      id: this.newIntentId("browse"),
      allowedActorIds: [event.actor.platformUserId],
      channel: event.channel,
      createdAt: this.now(),
      updatedAt: this.now(),
      expiresAt: this.now() + this.pendingIntentTtlMs,
      launchAction: parsed.launchAction,
      mode: selectedDirectory && parsed.mode === "recents" ? "project_threads" : parsed.mode,
      pageIndex: 0,
      pageSize: resumeBrowserPageSize(this.capabilityProfile),
      preferences: parsed.preferences
        ? {
            ...parsed.preferences,
            updatedAt: this.now(),
          }
        : undefined,
      query: parsed.query,
      selectedProject: selectedDirectory
        ? {
            directoryKey: selectedDirectory.key,
            label: selectedDirectory.label,
            path: selectedDirectory.path,
          }
        : undefined,
    };
    await this.renderResumeBrowser(session, navigation, event);
  }

  private async handleBrowseCallback(
    event: MessagingInboundCallbackEvent,
    actionId: string,
  ): Promise<void> {
    const session = await this.findBrowseSessionForCallback(event);
    if (!session) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("expired-browse"),
          createdAt: this.now(),
          title: "Action expired",
          body: "That browser action is no longer available. Use /resume to refresh.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    const navigation = await this.options.backend.getNavigationSnapshot({
      backend: "all",
      filter: session.query,
    });
    const nextSession = {
      ...session,
      updatedAt: this.now(),
    };

    if (actionId === "browse:page:next") {
      await this.renderResumeBrowser(
        { ...nextSession, pageIndex: nextSession.pageIndex + 1 },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:page:prev") {
      await this.renderResumeBrowser(
        { ...nextSession, pageIndex: Math.max(0, nextSession.pageIndex - 1) },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:mode:projects") {
      await this.renderResumeBrowser(
        {
          ...nextSession,
          launchAction: "resume_thread",
          mode: "projects",
          pageIndex: 0,
          selectedProject: undefined,
        },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:mode:recents") {
      await this.renderResumeBrowser(
        {
          ...nextSession,
          launchAction: "resume_thread",
          mode: "recents",
          pageIndex: 0,
          selectedProject: undefined,
        },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:mode:new") {
      await this.renderResumeBrowser(
        {
          ...nextSession,
          launchAction: "start_new_thread",
          mode: "new_project",
          pageIndex: 0,
          selectedProject: undefined,
        },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:cancel") {
      await this.options.store.deleteBrowseSession(session.id);
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("browse-cancelled"),
          capabilityProfile: this.capabilityProfile,
          createdAt: this.now(),
          delivery: session.surface
            ? {
                mode: "update",
                replaceMarkup: true,
              }
            : undefined,
          title: "Resume cancelled",
          body: "No thread binding changed.",
          targetSurface: session.surface,
        }),
        undefined,
        event,
      );
      return;
    }
    if (actionId === "browse:select-project") {
      const project = selectProjectFromValue(event.value);
      if (!project) {
        await this.deliverInvalidBrowseSelection(event);
        return;
      }
      if (session.launchAction === "start_new_thread") {
        await this.startNewThreadFromProject(event, session, navigation, project);
        return;
      }
      await this.renderResumeBrowser(
        {
          ...nextSession,
          mode: "project_threads",
          pageIndex: 0,
          selectedProject: project,
        },
        navigation,
        event,
      );
      return;
    }
    if (actionId === "browse:select-thread") {
      const target = selectThreadFromValue(event.value);
      if (!target) {
        await this.deliverInvalidBrowseSelection(event);
        return;
      }
      const binding = await this.bindChannelToThread(event, target);
      const updatedBinding = session.preferences
        ? await this.updateBindingPreferences(binding, session.preferences)
        : binding;
      await this.options.store.deleteBrowseSession(session.id);
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("bound"),
          capabilityProfile: this.capabilityProfile,
          createdAt: this.now(),
          delivery: session.surface
            ? {
                mode: "update",
                replaceMarkup: true,
              }
            : undefined,
          title: "Thread bound",
          body: "Messages in this conversation will route to the selected thread.",
          fallbackText: "Send a message to continue the thread.",
          targetSurface: session.surface,
        }),
        undefined,
        event,
      );
      await this.renderBindingStatus(updatedBinding, event, navigation);
      return;
    }

    await this.deliverInvalidBrowseSelection(event);
  }

  private async findBrowseSessionForCallback(
    event: MessagingInboundCallbackEvent,
  ): Promise<MessagingBrowseSessionRecord | undefined> {
    const callbackHandle = await this.resolveCallbackHandleForEvent(event);
    if (callbackHandle?.browseSessionId) {
      return await this.options.store.getBrowseSession(callbackHandle.browseSessionId, {
        now: this.now(),
      });
    }
    if (callbackHandle) {
      return undefined;
    }

    return await this.options.store.findActiveBrowseSessionForChannel({
      actorId: event.actor.platformUserId,
      channel: event.channel,
      now: this.now(),
    });
  }

  private async resolveCallbackHandleForEvent(
    event: MessagingInboundCallbackEvent,
  ): Promise<MessagingCallbackHandleRecord | undefined> {
    return await this.options.store.resolveCallbackHandle({
      actorId: event.actor.platformUserId,
      channel: event.channel,
      handle: event.interaction.id,
      now: this.now(),
    });
  }

  private async renderResumeBrowser(
    session: MessagingBrowseSessionRecord,
    navigation: Awaited<ReturnType<MessagingBackendBridge["getNavigationSnapshot"]>>,
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.options.store.upsertBrowseSession(session);
    const intent = buildResumeIntent({
      id: this.newIntentId("resume"),
      createdAt: this.now(),
      navigation,
      session,
    });
    await this.storePendingIntent(intent, undefined, event);
    const result = await this.deliver(intent, undefined, event);
    if (!result.surface) {
      return;
    }

    await this.options.store.upsertBrowseSession({
      ...session,
      surface: result.surface,
      updatedAt: this.now(),
    });
    await this.options.store.upsertPendingIntent({
      id: intent.id,
      channel: event.channel,
      intent,
      allowedActorIds: [event.actor.platformUserId],
      createdAt: this.now(),
      expiresAt: this.now() + this.pendingIntentTtlMs,
      surface: result.surface,
    });
  }

  private async startNewThreadFromProject(
    event: MessagingInboundCallbackEvent,
    session: MessagingBrowseSessionRecord,
    navigation: Awaited<ReturnType<MessagingBackendBridge["getNavigationSnapshot"]>>,
    project: NonNullable<ReturnType<typeof selectProjectFromValue>>,
  ): Promise<void> {
    if (!this.options.backend.startThread) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("new-thread-unavailable"),
          createdAt: this.now(),
          title: "New thread unavailable",
          body: "This backend does not support starting a thread from messaging yet.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    const directory = directoryForProjectSelection(navigation, project);
    const preferences = session.preferences;
    const started = await this.options.backend.startThread({
      backend: navigation.launchpadDefaults.backend,
      cwd: directory?.path ?? project.path,
      executionMode: preferences?.executionMode ?? navigation.launchpadDefaults.executionMode,
      fastMode: preferences?.fastMode ?? navigation.launchpadDefaults.fastMode,
      model: preferences?.model ?? navigation.launchpadDefaults.model,
      reasoningEffort:
        preferences?.reasoningEffort ?? navigation.launchpadDefaults.reasoningEffort,
      serviceTier: preferences?.serviceTier ?? navigation.launchpadDefaults.serviceTier,
    });
    const binding = await this.bindChannelToThread(event, {
      backend: started.backend,
      threadId: started.threadId,
    });
    const updatedBinding = preferences
      ? await this.updateBindingPreferences(binding, preferences)
      : binding;
    const optimisticNavigation = navigationWithStartedThread({
      backend: started.backend,
      directory,
      executionMode: started.executionMode,
      navigation,
      now: this.now(),
      preferences,
      project,
      threadId: started.threadId,
    });
    await this.options.store.deleteBrowseSession(session.id);
    await this.deliver(
      buildConfirmationIntent({
        id: this.newIntentId("new-thread-bound"),
        capabilityProfile: this.capabilityProfile,
        createdAt: this.now(),
        delivery: session.surface
          ? {
              mode: "update",
              replaceMarkup: true,
            }
          : undefined,
        title: "Thread started",
        body: `Started and bound a new thread for ${project.label}.`,
        fallbackText: "Send a message to continue the new thread.",
        targetSurface: session.surface,
      }),
      undefined,
      event,
    );
    await this.renderBindingStatus(updatedBinding, event, optimisticNavigation);
  }

  private async presentStatus(event: MessagingInboundEvent): Promise<void> {
    const binding = await this.options.store.findActiveBindingForChannel(event.channel);
    if (!binding) {
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("status-unbound"),
          capabilityProfile: this.capabilityProfile,
          createdAt: this.now(),
          title: "No thread bound",
          body: "Use /resume to choose a PwrAgent thread for this conversation.",
          actions: [
            {
              id: "command:resume",
              label: "Resume",
              style: "primary",
              fallbackText: "/resume",
            },
          ],
        }),
        undefined,
        event,
      );
      return;
    }

    await this.recreateBindingStatus(binding, event);
  }

  private async handleStatusCallback(
    event: MessagingInboundCallbackEvent,
    actionId: string,
  ): Promise<void> {
    if (actionId === "status:detach") {
      await this.detachBinding(event);
      return;
    }

    const binding = await this.options.store.findActiveBindingForChannel(event.channel);
    if (!binding) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("status-expired"),
          createdAt: this.now(),
          title: "Action expired",
          body: "That status action is no longer available. Use /status to refresh.",
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    if (actionId === "status:refresh" || actionId === "handoff:back-to-status") {
      // "Back" buttons from handoff sub-flows resolve to a status card
      // refresh, same as an explicit Refresh tap.
      await this.renderBindingStatus(binding, event);
      return;
    }
    if (actionId === "status:handoff") {
      await this.presentHandoffOverview(binding, event);
      return;
    }
    if (actionId === "handoff:cancel") {
      await this.clearActiveHandoffIntent(event);
      await this.renderBindingStatus(binding, event);
      return;
    }
    if (actionId === "handoff:local-to-worktree") {
      await this.presentHandoffBranchPicker(binding, event);
      return;
    }
    if (
      actionId === "handoff:branches:next" ||
      actionId === "handoff:branches:previous"
    ) {
      await this.presentHandoffBranchPicker(
        binding,
        event,
        handoffBranchPageIndexFromValue(event.value),
      );
      return;
    }
    if (actionId === "handoff:worktree-to-local") {
      await this.presentHandoffConfirmation(binding, event);
      return;
    }
    if (actionId === "handoff:select-leave-branch") {
      await this.presentHandoffConfirmation(binding, event);
      return;
    }
    if (actionId === "handoff:confirm") {
      await this.executeHandoff(binding, event);
      return;
    }
    if (actionId === "status:model") {
      await this.presentModelPicker(binding, event);
      return;
    }
    if (actionId === "status:reasoning") {
      await this.presentReasoningPicker(binding, event);
      return;
    }
    if (actionId === "status:set-model") {
      await this.setBindingModel(binding, event);
      return;
    }
    if (actionId === "status:set-reasoning") {
      await this.setBindingReasoning(binding, event);
      return;
    }
    if (actionId === "status:fast") {
      await this.toggleFastMode(binding, event);
      return;
    }
    if (actionId === "status:permissions") {
      await this.togglePermissionsMode(binding, event);
      return;
    }
    if (actionId === "status:tool-updates") {
      await this.cycleToolUpdateMode(binding, event);
      return;
    }
    if (actionId === "status:stop") {
      await this.stopActiveTurn(binding, event);
      return;
    }
    if (actionId === "status:compact") {
      await this.compactThread(binding, event);
      return;
    }
    if (actionId === "status:sync-name") {
      await this.syncConversationName(binding, event);
      return;
    }

    await this.deliver(
      buildConfirmationIntent({
        id: this.newIntentId("status-action-pending"),
        capabilityProfile: this.capabilityProfile,
        createdAt: this.now(),
        title: "Status action unavailable",
        body: "Use /status to refresh. This control will be wired to backend actions in the next implementation slice.",
      }),
      binding,
    );
  }

  private async presentHandoffOverview(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    if (!this.options.backend.handoffThreadWorkspace) {
      await this.deliverHandoffUnavailable(binding, event, "This runtime does not expose workspace handoff through messaging.");
      return;
    }

    const navigation = await this.options.backend.getNavigationSnapshot({ backend: "all" });
    const context = handoffContextForBinding(binding, navigation);
    if (!context) {
      await this.deliverHandoffUnavailable(binding, event, "This thread does not have enough Git workspace metadata for handoff.");
      return;
    }

    await this.deliverAndStoreStatusSubmode(
      {
        ...buildHandoffOverviewIntent({
          id: this.newIntentId("handoff-overview"),
          capabilityProfile: this.capabilityProfile,
          binding,
          context,
          createdAt: this.now(),
        }),
        audit: this.buildHandoffAudit("handoff.overview", binding, event),
      },
      binding,
      event,
    );
  }

  private async presentHandoffBranchPicker(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
    pageIndex = 0,
  ): Promise<void> {
    const navigation = await this.options.backend.getNavigationSnapshot({ backend: "all" });
    const context = handoffContextForBinding(binding, navigation);
    if (!context || context.workspaceKind !== "local") {
      await this.deliverHandoffUnavailable(binding, event, "This thread is not currently in a Local workspace that can move to a worktree.");
      return;
    }
    if (context.leaveLocalBranches.length === 0) {
      await this.deliverHandoffUnavailable(binding, event, "No safe branch choices are available to leave checked out in Local.");
      return;
    }

    await this.deliverAndStoreStatusSubmode(
      {
        ...buildHandoffBranchPickerIntent({
          id: this.newIntentId("handoff-branch"),
          capabilityProfile: this.capabilityProfile,
          binding,
          context,
          createdAt: this.now(),
          pageIndex,
        }),
        audit: this.buildHandoffAudit("handoff.branch_picker", binding, event),
      },
      binding,
      event,
    );
  }

  private async presentHandoffConfirmation(
    binding: MessagingBindingRecord,
    event: MessagingInboundCallbackEvent,
  ): Promise<void> {
    const navigation = await this.options.backend.getNavigationSnapshot({ backend: "all" });
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

    await this.deliverAndStoreStatusSubmode(
      {
        ...buildHandoffConfirmationIntent({
          id: this.newIntentId("handoff-confirm"),
          capabilityProfile: this.capabilityProfile,
          binding,
          context,
          createdAt: this.now(),
          leaveLocalBranch: request.leaveLocalBranch,
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

  private async executeHandoff(
    binding: MessagingBindingRecord,
    event: MessagingInboundCallbackEvent,
  ): Promise<void> {
    if (!this.options.backend.handoffThreadWorkspace) {
      await this.deliverHandoffUnavailable(binding, event, "This runtime does not expose workspace handoff through messaging.");
      return;
    }

    const request = handoffRequestFromValue(event.value);
    if (!request) {
      await this.deliverInvalidHandoffSelection(binding, event);
      return;
    }

    const currentBinding = await this.options.store.getBinding(binding.id);
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

    const navigation = await this.options.backend.getNavigationSnapshot({ backend: "all" });
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

    await this.deliver(
      {
        ...buildStatusIntent({
          id: this.newIntentId("handoff-running"),
          createdAt: this.now(),
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
      const result = await this.options.backend.handoffThreadWorkspace(request);
      await this.clearActiveHandoffIntent(event);
      const refreshedNavigation = await this.options.backend.getNavigationSnapshot({
        backend: "all",
      });
      const updatedBinding = await this.updateBindingAfterHandoff(
        currentBinding,
        result,
      );
      await this.deliver(
        {
          ...buildStatusIntent({
            id: this.newIntentId("handoff-completed"),
            createdAt: this.now(),
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
      await this.renderBindingStatus(updatedBinding, event, refreshedNavigation);
    } catch (error) {
      await this.deliver(
        {
          ...buildErrorIntent({
            id: this.newIntentId("handoff-failed"),
            createdAt: this.now(),
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

  private async updateBindingAfterHandoff(
    binding: MessagingBindingRecord,
    _result: HandoffThreadWorkspaceResponse,
  ): Promise<MessagingBindingRecord> {
    // Live navigation now owns status display metadata; keep the binding current
    // without restoring legacy threadDisplay cache fields that the store strips.
    return await this.options.store.upsertBinding({
      ...binding,
      updatedAt: this.now(),
    });
  }

  private async deliverAndStoreStatusSubmode(
    intent: MessagingSurfaceIntent,
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const pendingIntent = await this.storePendingIntent(intent, binding, event);
    const result = await this.deliver(intent, binding, event);
    if (!result.surface) {
      return;
    }
    await this.options.store.upsertPendingIntent({
      ...pendingIntent,
      surface: result.surface,
    });
    await this.options.store.upsertBinding({
      ...binding,
      statusSurface: result.surface,
      updatedAt: this.now(),
    });
  }

  private async clearActiveHandoffIntent(event: MessagingInboundEvent): Promise<void> {
    const pendingIntent = await this.options.store.findActivePendingIntentForChannel({
      actorId: event.actor.platformUserId,
      channel: event.channel,
      now: this.now(),
    });
    if (pendingIntent && pendingIntent.intent.id.includes("handoff")) {
      await this.options.store.deletePendingIntent(pendingIntent.id);
    }
  }

  private async deliverHandoffUnavailable(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
    body: string,
  ): Promise<void> {
    await this.deliver(
      {
        ...buildErrorIntent({
          id: this.newIntentId("handoff-unavailable"),
          createdAt: this.now(),
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
    await this.deliver(
      {
        ...buildErrorIntent({
          id: this.newIntentId("handoff-invalid"),
          createdAt: this.now(),
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
      now: this.now(),
      threadId: binding.threadId,
    });
  }

  private async presentModelPicker(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const summary = await this.getBackendSummary(binding.backend);
    const models = summary?.launchpadOptions?.models ?? [];
    if (models.length === 0) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("status-models-unavailable"),
          createdAt: this.now(),
          title: "Models unavailable",
          body: "This backend did not report model choices. Use /status to refresh.",
          recoverable: true,
        }),
        binding,
        event,
      );
      return;
    }

    await this.deliver(
      buildStatusModelPickerIntent({
        id: this.newIntentId("status-model-picker"),
        capabilityProfile: this.capabilityProfile,
        binding,
        createdAt: this.now(),
        models,
      }),
      binding,
      event,
    );
  }

  private async presentReasoningPicker(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const summary = await this.getBackendSummary(binding.backend);
    const efforts = summary?.launchpadOptions?.reasoningEfforts ?? [
      "low",
      "medium",
      "high",
    ];
    await this.deliver(
      buildStatusReasoningPickerIntent({
        id: this.newIntentId("status-reasoning-picker"),
        capabilityProfile: this.capabilityProfile,
        binding,
        createdAt: this.now(),
        efforts,
      }),
      binding,
      event,
    );
  }

  private async setBindingModel(
    binding: MessagingBindingRecord,
    event: MessagingInboundCallbackEvent,
  ): Promise<void> {
    const model = readStringValue(event.value, "model");
    if (!model) {
      await this.deliverInvalidStatusSelection(event);
      return;
    }

    const updatedBinding = await this.updateBindingPreferences(binding, {
      model,
    });
    await this.options.backend.setThreadModelSettings?.({
      backend: binding.backend,
      threadId: binding.threadId,
      model,
      fastMode: updatedBinding.preferences?.fastMode,
      reasoningEffort: updatedBinding.preferences?.reasoningEffort,
      serviceTier: updatedBinding.preferences?.serviceTier,
    });
    // Bus-driven refresh: setThreadModelSettings emits thread/modelSettings/updated
    // which fans out to refreshStatusSurfacesForThread for every controller —
    // including this one — so we don't need an inline render here.
  }

  private async setBindingReasoning(
    binding: MessagingBindingRecord,
    event: MessagingInboundCallbackEvent,
  ): Promise<void> {
    const reasoningEffort = readStringValue(event.value, "reasoningEffort");
    if (!reasoningEffort) {
      await this.deliverInvalidStatusSelection(event);
      return;
    }

    const updatedBinding = await this.updateBindingPreferences(binding, {
      reasoningEffort,
    });
    await this.options.backend.setThreadModelSettings?.({
      backend: binding.backend,
      threadId: binding.threadId,
      fastMode: updatedBinding.preferences?.fastMode,
      model: updatedBinding.preferences?.model,
      reasoningEffort,
      serviceTier: updatedBinding.preferences?.serviceTier,
    });
    // Refresh handled by the thread-state update bus on
    // thread/modelSettings/updated — see refreshStatusSurfacesForThread.
  }

  private async toggleFastMode(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const fastMode = !binding.preferences?.fastMode;
    const updatedBinding = await this.updateBindingPreferences(binding, {
      fastMode,
    });
    await this.options.backend.setThreadModelSettings?.({
      backend: binding.backend,
      threadId: binding.threadId,
      fastMode,
      model: updatedBinding.preferences?.model,
      reasoningEffort: updatedBinding.preferences?.reasoningEffort,
      serviceTier: updatedBinding.preferences?.serviceTier,
    });
    // Refresh handled by the thread-state update bus.
  }

  private async togglePermissionsMode(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const navigation = await this.options.backend.getNavigationSnapshot({
      backend: "all",
    });
    const thread = findThreadForBinding(navigation, binding);
    // When a queued change is already pending we toggle from the
    // *queued* target (so a second click reverses the queue), not from
    // the currently-applied mode. The registry's setThreadExecutionMode
    // handles "toggle back to currently-applied during queue → cancel".
    const currentMode =
      thread?.queuedExecutionMode ??
      executionModeForBinding(binding, navigation) ??
      "default";
    const nextMode = currentMode === "full-access" ? "default" : "full-access";
    const executionMode = nextMode;
    // Update local binding prefs first so the bus-path render — which
    // fetches the binding fresh from the store — sees the new values
    // even if navigation snapshot hasn't reloaded yet. The registry
    // decides queue-vs-apply; on the queue path the bus emits
    // `thread/executionMode/queued` (not `updated`), and the prefs we
    // wrote here will get unwound naturally if the queue is cancelled
    // before applying — the pre-flip here matches the optimistic-UI
    // behavior the desktop renderer uses, and the bus refresh pulls
    // canonical state on the apply or cancel transition.
    await this.updateBindingPreferences(binding, {
      executionMode,
      permissionsMode: nextMode,
    });
    await this.options.backend.setThreadExecutionMode?.({
      backend: binding.backend,
      threadId: binding.threadId,
      executionMode,
    });
    // Refresh handled by the thread-state update bus on
    // thread/executionMode/updated — see refreshStatusSurfacesForThread.
  }

  /**
   * Handle a tap on the Cancel button of a queued-permissions audit
   * message. The actionId is `permissions:queue:cancel:${queueId}`; we
   * validate that the queueId still matches the active tracking entry
   * before calling the bridge.
   *
   * Stale-click feedback (mirroring `handleQueuedTurnCallback`'s
   * "queued message no longer waiting" pattern): if the queue this
   * button references has already been applied or cancelled, OR a
   * different queue has replaced it, we post an explicit "no longer
   * waiting" reply instead of silently routing through the registry's
   * idempotent no-op. This is the same UX contract queued reply
   * messages have used since `2026-05-03-001-fix-messaging-turn-admission-plan.md`.
   *
   * The visual button SHOULD have been removed by the
   * `handleExecutionModeQueueCleared` edit when the queue resolved,
   * but Telegram/Discord chat history can still show stale buttons
   * (the user scrolled up; the edit failed; the tab was offline at
   * the time of the edit; etc.) — we treat the click as the
   * authoritative "user wants to interact with this queue" signal
   * and respond with the truth at click time.
   */
  private async handlePermissionsQueueCancelCallback(
    event: MessagingInboundCallbackEvent,
    queueId: string,
  ): Promise<void> {
    const binding = await this.options.store.findActiveBindingForChannel(event.channel);
    if (!binding) {
      return;
    }

    const queueKey = this.queueAuditKey(binding.backend, binding.threadId);
    const tracking = this.pendingQueueAuditMessages.get(queueKey);
    const isStale = !tracking || tracking.queueId !== queueId;
    if (isStale) {
      try {
        await this.deliver(
          buildErrorIntent({
            id: this.newIntentId("expired-permissions-queue"),
            createdAt: this.now(),
            title: "Permissions change unavailable",
            body: "That queued permissions change is no longer waiting.",
            recoverable: true,
          }),
          binding,
          event,
        );
      } catch (error) {
        this.logger.debug?.(
          "messaging permissions-queue stale-cancel notice failed",
          {
            bindingId: binding.id,
            threadId: binding.threadId,
            queueId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
      return;
    }

    if (!this.options.backend.cancelThreadExecutionModeQueue) {
      return;
    }
    try {
      await this.options.backend.cancelThreadExecutionModeQueue({
        backend: binding.backend,
        threadId: binding.threadId,
      });
    } catch (error) {
      this.logger.debug?.("messaging permissions-queue cancel failed", {
        bindingId: binding.id,
        threadId: binding.threadId,
        queueId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async stopActiveTurn(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const activeTurn = this.getActiveTurn(binding);
    if (!activeTurn || !["working", "waiting"].includes(activeTurn.status)) {
      await this.renderBindingStatus(binding, event);
      return;
    }
    await this.options.backend.interruptTurn?.({
      backend: binding.backend,
      threadId: binding.threadId,
      turnId: activeTurn.turnId,
    });
    const interruptedTurn: MessagingActiveTurnSummary = {
      ...activeTurn,
      status: "interrupted",
      updatedAt: this.now(),
    };
    this.setActiveTurn(binding, interruptedTurn);
    await this.signalTurnActivity(binding, interruptedTurn, {
      force: true,
    });
    await this.renderBindingStatus(binding, event);
  }

  private async compactThread(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    if (!this.options.backend.compactThread) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("status-compact-unavailable"),
          createdAt: this.now(),
          title: "Compact unavailable",
          body: "This backend does not expose thread compaction through messaging.",
          recoverable: true,
        }),
        binding,
        event,
      );
      return;
    }

    const compacted = await this.options.backend.compactThread({
      backend: binding.backend,
      threadId: binding.threadId,
    });
    const activeTurn: MessagingActiveTurnSummary = {
      turnId: compacted.turnId,
      status: "working",
      startedAt: this.now(),
      updatedAt: this.now(),
    };
    this.setActiveTurn(binding, activeTurn);
    await this.signalTurnActivity(binding, activeTurn, {
      force: true,
    });
    await this.renderBindingStatus(binding, event);
  }

  private async syncConversationName(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    if (!this.options.adapter.setConversationTitle) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("status-sync-name-unavailable"),
          createdAt: this.now(),
          title: "Name sync unavailable",
          body: "This messaging provider does not support syncing the conversation name.",
          recoverable: true,
        }),
        binding,
        event,
      );
      return;
    }

    const navigation = await this.options.backend.getNavigationSnapshot({
      backend: "all",
    });
    const threadState = resolveMessagingThreadState({
      activeTurn: this.getActiveTurn(binding),
      binding,
      navigation,
    });
    const threadTitle = normalizeConversationTitle(threadState.title);
    if (!threadTitle) {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("status-sync-name-missing-title"),
          createdAt: this.now(),
          title: "Name sync unavailable",
          body: "This thread does not have a Codex thread name to sync yet.",
          recoverable: true,
        }),
        binding,
        event,
      );
      return;
    }

    const result = await this.options.adapter.setConversationTitle({
      actor: event.actor,
      channel: binding.channel,
      routingState: event.routingState ?? binding.routingState,
      title: threadTitle,
    });
    if (result.outcome !== "updated") {
      await this.deliver(
        buildErrorIntent({
          id: this.newIntentId("status-sync-name-failed"),
          createdAt: this.now(),
          title: "Name sync unavailable",
          body:
            result.errorMessage ??
            `This ${conversationKindLabel(binding.channel.conversation.kind)} cannot be renamed from messaging.`,
          recoverable: true,
        }),
        binding,
        event,
      );
      return;
    }

    const updatedBinding = await this.options.store.upsertBinding({
      ...binding,
      channel: {
        ...binding.channel,
        conversation: {
          ...binding.channel.conversation,
          title: result.title,
        },
      },
      updatedAt: this.now(),
    });
    // Title changed — make the chip's label/tooltip pick up the new
    // value without waiting for the next backend tick.
    this.notifyBindingChanged("sync-conversation-name");
    await this.deliver(
      buildConfirmationIntent({
        id: this.newIntentId("status-sync-name-confirmed"),
        capabilityProfile: this.capabilityProfile,
        createdAt: this.now(),
        title: "Name synced",
        body: `Set this ${conversationKindLabel(binding.channel.conversation.kind)} name to "${result.title}".`,
      }),
      updatedBinding,
      event,
    );
    await this.renderBindingStatus(updatedBinding, event, navigation);
  }

  private async cycleToolUpdateMode(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<void> {
    const currentMode = resolveMessagingToolUpdateMode(
      binding,
      await this.resolveToolUpdateDefaultMode(),
    );
    const updatedBinding = await this.updateBindingPreferences(binding, {
      toolUpdateMode: nextMessagingToolUpdateMode(currentMode),
    });
    await this.renderBindingStatus(updatedBinding, event);
  }

  private async updateBindingPreferences(
    binding: MessagingBindingRecord,
    patch: Partial<NonNullable<MessagingBindingRecord["preferences"]>>,
  ): Promise<MessagingBindingRecord> {
    return await this.options.store.upsertBinding({
      ...binding,
      preferences: {
        ...binding.preferences,
        ...patch,
        updatedAt: this.now(),
      },
      updatedAt: this.now(),
    });
  }

  private async getBackendSummary(backend: AppServerBackendKind) {
    const response = await this.options.backend.listBackends?.({
      includeUnavailable: true,
    });
    return response?.backends.find((candidate) => candidate.kind === backend);
  }

  private async deliverInvalidStatusSelection(
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.deliver(
      buildErrorIntent({
        id: this.newIntentId("invalid-status-selection"),
        createdAt: this.now(),
        title: "Invalid status selection",
        body: "That status selection is no longer available. Use /status to refresh.",
        recoverable: true,
      }),
      undefined,
      event,
    );
  }

  private async detachBinding(event: MessagingInboundEvent): Promise<void> {
    const binding = await this.options.store.findActiveBindingForChannel(event.channel);
    if (!binding) {
      await this.deliver(
        buildConfirmationIntent({
          id: this.newIntentId("detach-unbound"),
          capabilityProfile: this.capabilityProfile,
          createdAt: this.now(),
          title: "No thread bound",
          body: "This conversation is not bound to a PwrAgent thread.",
        }),
        undefined,
        event,
      );
      return;
    }
    await this.runDetachPipeline(binding, event);
  }

  /**
   * Platform-agnostic detach pipeline. Called by both the inbound
   * `/detach` slash-command path and the bus-driven UI / archive
   * paths. The only seam for platform-specific behavior is
   * `this.options.adapter.deliver`, which the registered adapter
   * implements per the messaging contract — adding a new platform
   * requires zero changes to this method. `event` is supplied only
   * when the detach was initiated by an inbound command (used for
   * audit context and reply targeting); for non-inbound origins
   * (`requestBindingRevoke` from IPC, archive flows) the binding's
   * own channel is the routing source.
   */
  private async runDetachPipeline(
    binding: MessagingBindingRecord,
    event?: MessagingInboundEvent,
  ): Promise<void> {
    const activeTurn = this.getActiveTurn(binding);
    if (activeTurn) {
      await this.signalTurnActivity(
        binding,
        {
          ...activeTurn,
          status: "interrupted",
          updatedAt: this.now(),
        },
        { force: true },
      );
    }
    await this.flushToolUpdatesForBinding(binding, { clear: true });
    await this.retireBindingStatus(
      binding,
      event,
      await this.options.backend.getNavigationSnapshot({ backend: "all" }),
    );

    await this.options.store.revokeBinding({
      bindingId: binding.id,
      revokedAt: this.now(),
    });
    this.notifyBindingChanged("detach");
    await this.deliver(
      buildConfirmationIntent({
        id: this.newIntentId("detached"),
        capabilityProfile: this.capabilityProfile,
        createdAt: this.now(),
        title: "Thread detached",
        body: "Messages in this conversation will no longer route to PwrAgent.",
      }),
      binding,
      event,
    );
  }

  /**
   * Bus-driven entry point used by the runtime when an UI / archive
   * caller emits `requestBindingRevoke`. Returns true if this
   * controller's adapter owns the binding's channel and therefore
   * handled the revoke; false otherwise so the runtime can try the
   * next controller (or fall back to a direct store revoke if no
   * controller matches — e.g., messaging is currently disabled).
   */
  async handleBindingRevokeRequest(
    binding: MessagingBindingRecord,
  ): Promise<boolean> {
    if (!this.isChannelInScope(binding.channel)) {
      return false;
    }
    await this.runDetachPipeline(binding, undefined);
    return true;
  }

  private async recreateBindingStatus(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent,
  ): Promise<MessagingBindingRecord> {
    const snapshot = await this.options.backend.getNavigationSnapshot({
      backend: "all",
    });
    const retiredBinding = await this.retireBindingStatus(binding, event, snapshot);
    return await this.renderBindingStatus(retiredBinding, event, snapshot);
  }

  private async resolveToolUpdateDefaultMode(): Promise<MessagingToolUpdateMode> {
    const configured = this.options.toolUpdateDefaultMode;
    if (!configured) {
      return "show_some";
    }

    try {
      return typeof configured === "function" ? await configured() : configured;
    } catch (error) {
      this.logger.debug?.("messaging tool update default resolution failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return "show_some";
    }
  }

  private async retireBindingStatus(
    binding: MessagingBindingRecord,
    event: MessagingInboundEvent | undefined,
    navigation: NavigationSnapshot,
  ): Promise<MessagingBindingRecord> {
    const statusSurface = binding.statusSurface ?? binding.pinnedStatusSurface;
    if (!statusSurface) {
      return binding;
    }

    try {
      await this.deliver(
        {
          ...buildBindingStatusIntent({
            id: this.newIntentId("status-retire"),
            binding,
            capabilityProfile: this.capabilityProfile,
            createdAt: this.now(),
            threadState: resolveMessagingThreadState({
              activeTurn: this.getActiveTurn(binding),
              binding,
              navigation,
            }),
            toolUpdateMode: await this.resolveToolUpdateDefaultMode(),
          }),
          actions: [],
          delivery: {
            mode: "update",
            replaceMarkup: true,
            fallback: "fail",
          },
          targetSurface: statusSurface,
        },
        binding,
        event,
      );
    } catch (error) {
      this.logger.debug?.("messaging status retirement update failed", {
        bindingId: binding.id,
        error: error instanceof Error ? error.message : String(error),
        threadId: binding.threadId,
      });
    }

    if (binding.pinnedStatusSurface) {
      try {
        await this.deliver(
          {
            id: this.newIntentId("status-unpin"),
            kind: "dismiss",
            bindingId: binding.id,
            createdAt: this.now(),
            delivery: {
              mode: "dismiss",
              unpin: true,
            },
            reason: "status_recreated",
            targetSurface: binding.pinnedStatusSurface,
          },
          binding,
          event,
        );
      } catch (error) {
        this.logger.debug?.("messaging status retirement unpin failed", {
          bindingId: binding.id,
          error: error instanceof Error ? error.message : String(error),
          threadId: binding.threadId,
        });
      }
    }

    return await this.options.store.upsertBinding({
      ...binding,
      pinnedStatusSurface: undefined,
      statusSurface: undefined,
      updatedAt: this.now(),
    });
  }

  private async renderBindingStatus(
    binding: MessagingBindingRecord,
    event?: MessagingInboundEvent,
    navigation?: NavigationSnapshot,
  ): Promise<MessagingBindingRecord> {
    const snapshot =
      navigation ??
      (await this.options.backend.getNavigationSnapshot({
        backend: "all",
      }));
    const activeTurn = await this.reconcileActiveTurnFromBackendStatus(
      binding,
      "status_refresh",
    );
    const intent = buildBindingStatusIntent({
      id: this.newIntentId("status"),
      binding,
      capabilityProfile: this.capabilityProfile,
      createdAt: this.now(),
      handoff: this.options.backend.handoffThreadWorkspace
        ? handoffContextForBinding(binding, snapshot)
        : undefined,
      threadState: resolveMessagingThreadState({
        activeTurn,
        binding,
        navigation: snapshot,
      }),
      toolUpdateMode: await this.resolveToolUpdateDefaultMode(),
    });
    const result = await this.deliver(intent, binding, event);
    if (!result.surface) {
      return binding;
    }

    return await this.options.store.upsertBinding({
      ...binding,
      pinnedStatusSurface:
        result.outcome === "pinned"
          ? result.surface
          : binding.pinnedStatusSurface,
      statusSurface: result.surface,
      updatedAt: this.now(),
    });
  }

  private async reconcileActiveTurnFromBackendStatus(
    binding: MessagingBindingRecord,
    reason: string,
  ): Promise<MessagingActiveTurnSummary | undefined> {
    const activeTurn = this.getActiveTurn(binding);
    if (
      !activeTurn ||
      activeTurn.status !== "working" ||
      !this.options.backend.readThreadStatus
    ) {
      return activeTurn;
    }

    const threadStatus = await this.options.backend.readThreadStatus({
      backend: binding.backend,
      threadId: binding.threadId,
    });
    if (threadStatus !== "idle") {
      return activeTurn;
    }

    const completedTurn: MessagingActiveTurnSummary = {
      ...activeTurn,
      status: "completed",
      updatedAt: this.now(),
    };
    this.setActiveTurn(binding, completedTurn);
    this.logBindingTurnStateChange(
      binding,
      activeTurn,
      completedTurn,
      `${reason}:thread_status_idle`,
    );
    await this.signalTurnActivity(binding, completedTurn, {
      force: true,
      reason: `${reason}:thread_status_idle`,
    });
    return completedTurn;
  }

  private getActiveTurn(
    binding: MessagingBindingRecord,
  ): MessagingActiveTurnSummary | undefined {
    return this.activeTurnsByThreadKey.get(this.threadKeyForBinding(binding));
  }

  private setActiveTurn(
    binding: MessagingBindingRecord,
    activeTurn: MessagingActiveTurnSummary,
  ): void {
    this.activeTurnsByThreadKey.set(this.threadKeyForBinding(binding), activeTurn);
  }

  private threadKeyForBinding(binding: MessagingBindingRecord): string {
    return threadKeyForBinding(binding);
  }

  private async signalTurnActivity(
    binding: MessagingBindingRecord,
    activeTurn: MessagingActiveTurnSummary,
    options?: { force?: boolean; reason?: string },
  ): Promise<void> {
    const state = activeTurn.status === "working" ? "active" : "idle";
    const now = this.now();
    const lastSignaledAt = this.typingActivityLastSignaledAt.get(binding.id);
    if (
      state === "active" &&
      !options?.force &&
      lastSignaledAt !== undefined &&
      now - lastSignaledAt < TYPING_ACTIVITY_REFRESH_MS
    ) {
      return;
    }
    if (state === "active") {
      this.typingActivityLastSignaledAt.set(binding.id, now);
    } else {
      this.typingActivityLastSignaledAt.delete(binding.id);
    }

    this.logger.debug?.(
      `messaging typing signaled state=${state} reason=${options?.reason ?? "unknown"} force=${Boolean(options?.force)} leaseMs=${state === "active" ? TYPING_ACTIVITY_LEASE_MS : "none"} status=${activeTurn.status} thread=${binding.threadId} turn=${activeTurn.turnId} binding=${binding.id}`,
    );

    await this.deliver(
      buildActivityIntent({
        id: this.newIntentId("activity"),
        activity: "typing",
        bindingId: binding.id,
        createdAt: now,
        leaseMs: state === "active" ? TYPING_ACTIVITY_LEASE_MS : undefined,
        state,
      }),
      binding,
    );
  }

  private logBindingTurnStateChange(
    binding: MessagingBindingRecord,
    previousTurn: MessagingActiveTurnSummary | undefined,
    nextTurn: MessagingActiveTurnSummary | undefined,
    reason: string,
  ): void {
    if (
      previousTurn?.turnId === nextTurn?.turnId &&
      previousTurn?.status === nextTurn?.status
    ) {
      return;
    }

    this.logger.debug?.(
      `messaging turn state changed reason=${reason} backend=${binding.backend} thread=${binding.threadId} binding=${binding.id} previous=${previousTurn?.status ?? "none"}:${previousTurn?.turnId ?? "none"} next=${nextTurn?.status ?? "none"}:${nextTurn?.turnId ?? "none"}`,
    );
  }

  private async deliverInvalidBrowseSelection(
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.deliver(
      buildErrorIntent({
        id: this.newIntentId("invalid-browse-selection"),
        createdAt: this.now(),
        title: "Invalid selection",
        body: "That resume selection is no longer available. Use /resume to refresh.",
        recoverable: true,
      }),
      undefined,
      event,
    );
  }

  /**
   * Best-effort fan-out to the runtime's bindings-changed listener.
   * Wrapped so a misbehaving listener (e.g. closed BrowserWindow) can
   * never abort the mutation that produced the event.
   */
  private notifyBindingChanged(reason: string): void {
    if (!this.options.onBindingChanged) return;
    try {
      this.options.onBindingChanged();
    } catch (error) {
      this.logger.debug?.("messaging onBindingChanged listener threw", {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async bindChannelToThread(
    event: MessagingInboundCallbackEvent,
    target: { backend: AppServerBackendKind; threadId: ThreadIdentifier },
  ): Promise<MessagingBindingRecord> {
    const now = this.now();
    const binding: MessagingBindingRecord = {
      id: `binding:${buildMessagingConversationKey(event.channel)}:${target.backend}:${target.threadId}`,
      channel: event.channel,
      backend: target.backend,
      threadId: target.threadId,
      authorizedActorIds: [event.actor.platformUserId],
      routingState: event.routingState,
      createdAt: now,
      updatedAt: now,
      displayName: event.actor.displayName ?? event.actor.username,
    };
    const upserted = await this.options.store.upsertBinding(binding);
    // Retire any channel-scoped pending intents that pre-date this
    // bind. Without this, the resume browser's pending intent (and any
    // other pre-binding picker intent) survives the bind, and the next
    // text inbound on this channel matches the stale picker — making
    // the bot bounce "Choose an option" instead of routing to the new
    // binding. Best-effort: log and continue if the cleanup fails so
    // the bind itself still succeeds (fresh binding is the source of
    // truth; stale intents will eventually be evicted by TTL GC).
    //
    // Not transactional with `upsertBinding` on purpose: the store
    // API doesn't expose a transaction boundary for cross-row work,
    // and adding one would push transaction plumbing into the
    // messaging interface — over-architecture for a recovery window
    // measured in minutes. If the process crashes between these two
    // writes, the next bind on the same channel re-runs the cleanup,
    // and the TTL GC catches anything missed within 15 minutes.
    try {
      const removed = await this.options.store.deletePendingIntentsForChannel({
        channel: event.channel,
      });
      if (removed.length > 0) {
        this.logger.debug?.("messaging retired channel pending intents on bind", {
          bindingId: upserted.id,
          channel: event.channel.channel,
          removedCount: removed.length,
        });
      }
    } catch (error) {
      this.logger.debug?.(
        "messaging channel pending-intent cleanup failed on bind",
        {
          bindingId: upserted.id,
          channel: event.channel.channel,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
    // Renderer's binding chip is fed by the navigation snapshot. The
    // snapshot only refetches on backend events — and binding creation
    // doesn't emit one. Fan out a bindings-changed notification so the
    // UI picks up the new chip immediately (issue #191).
    this.notifyBindingChanged("bind");
    return upserted;
  }

  private intentForPendingRequest(
    request: AppServerPendingRequestNotification,
  ): MessagingSurfaceIntent | undefined {
    if (request.method === "item/tool/requestUserInput") {
      return buildQuestionnaireIntent({
        id: this.newIntentId("questionnaire"),
        capabilityProfile: this.capabilityProfile,
        createdAt: this.now(),
        request: request as AppServerToolRequestUserInputNotification,
      });
    }

    if (request.method.toLowerCase().includes("requestapproval")) {
      return buildApprovalIntent({
        id: this.newIntentId("approval"),
        capabilityProfile: this.capabilityProfile,
        createdAt: this.now(),
        request,
      });
    }

    return undefined;
  }

  private async storePendingIntent(
    intent: MessagingSurfaceIntent,
    binding?: MessagingBindingRecord,
    event?: MessagingInboundEvent,
  ): Promise<MessagingPendingIntentRecord> {
    return await this.options.store.upsertPendingIntent({
      id: intent.id,
      bindingId: binding?.id,
      channel: binding?.channel ?? event?.channel,
      intent,
      allowedActorIds: binding?.authorizedActorIds ?? [
        event?.actor.platformUserId ?? "unknown",
      ],
      createdAt: this.now(),
      expiresAt: this.now() + this.pendingIntentTtlMs,
    });
  }

  private recordOutboundActivity(
    intent: MessagingSurfaceIntent,
    binding: MessagingBindingRecord | undefined,
    result: MessagingDeliveryResult,
  ): void {
    // Only log user-visible deliveries — status/typing/dismiss are
    // every-tick noise and would drown the activity feed.
    if (
      intent.kind !== "message"
      && intent.kind !== "approval"
      && intent.kind !== "error"
    ) {
      return;
    }
    const channel = binding?.channel.channel ?? result.channel;
    if (!channel) return;
    const conversation = binding?.channel.conversation;
    const summary = describeOutboundIntent(intent);
    try {
      // Lazy import keeps the controller free of a top-level dep on
      // the desktop activity-log singleton (the controller is shared
      // with other harnesses; this method is the only main-process
      // entry that needs it).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const log = (require(
        "../desktop-messaging-activity-log",
      ) as typeof import("../desktop-messaging-activity-log"))
        .getDesktopMessagingActivityLog();
      log.record({
        platform: channel,
        kind: "outbound",
        backend: binding?.backend,
        threadId: binding?.threadId,
        bindingId: binding?.id,
        conversationId: conversation?.id,
        conversationTitle: conversation?.title,
        summary,
        payload: {
          intentId: intent.id,
          intentKind: intent.kind,
          outcome: result.outcome,
        },
      });
    } catch {
      // Activity log is best-effort observability; never break delivery
      // because the log threw.
    }
  }

  private async deliver(
    intent: MessagingSurfaceIntent,
    binding?: MessagingBindingRecord,
    event?: MessagingInboundEvent,
  ): Promise<MessagingDeliveryResult> {
    if (binding && shouldFlushToolUpdatesBeforeIntent(intent)) {
      await this.flushToolUpdatesForBinding(binding, { clear: false });
    }
    const routedIntent = this.withRoutingAudit(intent, binding, event);
    const result = await this.options.adapter.deliver(routedIntent);
    await this.options.store.recordDelivery({
      ...result,
      id: `delivery:${routedIntent.id}:${randomUUID()}`,
      bindingId: binding?.id ?? intent.bindingId,
      intentId: routedIntent.id,
    });
    this.recordOutboundActivity(routedIntent, binding, result);
    if (
      binding &&
      result.channel === binding.channel.channel &&
      isPermanentMessagingTargetFailure(result)
    ) {
      await this.options.store.revokeBinding({
        bindingId: binding.id,
        revokedAt: this.now(),
      });
      this.notifyBindingChanged("permanent-delivery-failure");
      this.logger.debug?.("messaging binding revoked after permanent delivery failure", {
        bindingId: binding.id,
        channel: binding.channel.channel,
        conversationId: binding.channel.conversation.id,
        errorMessage: result.errorMessage,
        outcome: result.outcome,
        threadId: binding.threadId,
      });
    }
    return result;
  }

  private async deliverToolActivityForBackendEvent(
    event: AgentEvent,
    binding: MessagingBindingRecord,
    activeTurnId?: string,
  ): Promise<void> {
    const turnId = turnIdForBackendEvent(event) ?? activeTurnId;
    if (!turnId) {
      return;
    }

    const activity = summarizeToolActivityFromBackendEvent(event);
    if (!activity) {
      return;
    }

    const mode = resolveMessagingToolUpdateMode(
      binding,
      await this.resolveToolUpdateDefaultMode(),
    );
    const deliveries = this.toolUpdatePolicy.processActivity({
      activity,
      bindingId: binding.id,
      mode,
      turnId,
    });
    for (const delivery of deliveries) {
      await this.deliverToolUpdateDelivery(delivery, binding);
    }
  }

  private async flushToolUpdatesForBinding(
    binding: MessagingBindingRecord,
    options: { clear: boolean; turnId?: string },
  ): Promise<void> {
    const deliveries = this.toolUpdatePolicy.flush({
      bindingId: binding.id,
      clear: options.clear,
      turnId: options.turnId,
    });
    for (const delivery of deliveries) {
      await this.deliverToolUpdateDelivery(delivery, binding);
    }
  }

  private async deliverToolUpdateDelivery(
    delivery: MessagingToolUpdatePolicyDelivery,
    knownBinding?: MessagingBindingRecord,
  ): Promise<void> {
    const binding =
      knownBinding?.id === delivery.bindingId
        ? knownBinding
        : await this.options.store.getBinding(delivery.bindingId);
    if (!binding || binding.revokedAt || !this.isChannelInScope(binding.channel)) {
      return;
    }

    const intent =
      delivery.kind === "individual"
        ? buildToolUpdateMessageIntent({
            activity: delivery.activities[0]!,
            bindingId: binding.id,
            createdAt: this.now(),
            id: this.newIntentId("tool-update"),
          })
        : buildToolUpdateBatchMessageIntent({
            activities: delivery.activities,
            bindingId: binding.id,
            createdAt: this.now(),
            id: this.newIntentId("tool-update-batch"),
          });
    await this.deliver(intent, binding);
  }

  private filterBindingsForChannel(
    bindings: MessagingBindingRecord[],
  ): MessagingBindingRecord[] {
    if (!this.options.channel) {
      return bindings;
    }
    return bindings.filter((binding) => binding.channel.channel === this.options.channel);
  }

  private isChannelInScope(channel: MessagingBindingRecord["channel"] | undefined): boolean {
    return !this.options.channel || channel?.channel === this.options.channel;
  }

  private withRoutingAudit(
    intent: MessagingSurfaceIntent,
    binding?: MessagingBindingRecord,
    event?: MessagingInboundEvent,
  ): MessagingSurfaceIntent {
    if (intent.audit || (!binding && !event)) {
      return intent;
    }

    const channel = binding?.channel ?? event?.channel;
    if (!channel) {
      return intent;
    }

    return {
      ...intent,
      audit: buildMessagingAuditContext({
        actor: event?.actor ?? {
          platformUserId: binding?.authorizedActorIds[0] ?? "unknown",
        },
        action: "intent.deliver",
        backend: binding?.backend,
        bindingId: binding?.id ?? intent.bindingId,
        channel,
        now: this.now(),
        threadId: binding?.threadId,
      }),
      ...(intent.targetSurface
        ? { targetSurface: intent.targetSurface }
        : event?.routingState
          ? {
              targetSurface: {
                channel: channel.channel,
                id: event.id,
                state: event.routingState,
              },
            }
          : {}),
    };
  }

  private isAuthorized(platformUserId: string): boolean {
    return this.authorizedActorIds.has(platformUserId);
  }

  private newIntentId(prefix: string): string {
    return `${prefix}:${randomUUID()}`;
  }
}

function readCommandAction(event: MessagingInboundCallbackEvent): string | undefined {
  const actionId = event.actionId ?? event.interaction.id;
  const match = /^command:([a-z0-9_-]+)$/i.exec(actionId);
  return match?.[1]?.toLowerCase();
}

/**
 * Narrow an `AppServerNotification` to the `thread/executionMode/queued`
 * variant and return its strongly-typed params. The shared union is
 * tricky to narrow because `AppServerPendingRequestNotification` widens
 * `method: string`, so we look at the params shape too.
 */
function readExecutionModeQueuedParams(
  notification: AgentEvent["notification"],
):
  | { threadId: ThreadIdentifier; queuedExecutionMode: ThreadExecutionMode; queuedAt: number }
  | undefined {
  if (notification.method !== "thread/executionMode/queued") {
    return undefined;
  }
  const params = notification.params as {
    threadId?: unknown;
    queuedExecutionMode?: unknown;
    queuedAt?: unknown;
  };
  if (
    typeof params.threadId === "string" &&
    (params.queuedExecutionMode === "default" || params.queuedExecutionMode === "full-access") &&
    typeof params.queuedAt === "number"
  ) {
    return {
      threadId: params.threadId,
      queuedExecutionMode: params.queuedExecutionMode,
      queuedAt: params.queuedAt,
    };
  }
  return undefined;
}

function readExecutionModeQueueClearedParams(
  notification: AgentEvent["notification"],
): { threadId: ThreadIdentifier; reason: "applied" | "cancelled" } | undefined {
  if (notification.method !== "thread/executionMode/queueCleared") {
    return undefined;
  }
  const params = notification.params as {
    threadId?: unknown;
    reason?: unknown;
  };
  if (
    typeof params.threadId === "string" &&
    (params.reason === "applied" || params.reason === "cancelled")
  ) {
    return { threadId: params.threadId, reason: params.reason };
  }
  return undefined;
}

/**
 * Format a wall-clock timestamp as `HH:MM AM/PM` for messaging audit
 * messages. Mirrors the format the user sees in the desktop transcript.
 */
function formatTimeOfDay(epochMs: number): string {
  const date = new Date(epochMs);
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const period = hours >= 12 ? "PM" : "AM";
  const displayHours = hours % 12 === 0 ? 12 : hours % 12;
  const paddedMinutes = minutes < 10 ? `0${minutes}` : String(minutes);
  return `${displayHours}:${paddedMinutes} ${period}`;
}

function readBrowseAction(event: MessagingInboundCallbackEvent): string | undefined {
  const actionId = event.actionId ?? event.interaction.id;
  return actionId.startsWith("browse:") ? actionId : undefined;
}

function readHelpNavAction(event: MessagingInboundCallbackEvent): string | undefined {
  const actionId = event.actionId ?? event.interaction.id;
  if (
    actionId === "help:page:next"
    || actionId === "help:page:prev"
    || actionId === "help:cancel"
  ) {
    return actionId;
  }
  return undefined;
}

/**
 * Read the target page index from a help-nav callback's value
 * payload. Returns 0 (first page) when the value is missing or
 * malformed — clamping in `paginateHelpCatalog` will pin to the
 * first/last page anyway, so an absent value never crashes the
 * re-render.
 */
function readHelpPageIndex(event: MessagingInboundCallbackEvent): number {
  const value = event.value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidate = (value as Record<string, unknown>).pageIndex;
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0) {
      return candidate;
    }
  }
  return 0;
}

function readStatusAction(event: MessagingInboundCallbackEvent): string | undefined {
  const actionId = event.actionId ?? event.interaction.id;
  return actionId.startsWith("status:") || actionId.startsWith("handoff:")
    ? actionId
    : undefined;
}

/**
 * Match the cancel button on a "Permissions queued" audit message. The
 * action id is `permissions:queue:cancel:${queueId}`; the queueId is
 * encoded so multiple queue posts in the same conversation can't
 * collide. Returns the parsed queueId on match, undefined otherwise.
 *
 * The queueId is what the controller-side tracking map keys against,
 * so the cancel handler can detect stale clicks (the apply has
 * already happened, or a different queue has replaced this one) and
 * respond with explicit feedback rather than silently no-op'ing
 * through the registry's `cancelThreadExecutionModeQueue` call.
 */
function readPermissionsQueueCancelAction(
  event: MessagingInboundCallbackEvent,
): { queueId: string } | undefined {
  const actionId = event.actionId ?? event.interaction.id;
  if (!actionId.startsWith(PERMISSIONS_QUEUE_CANCEL_ACTION_PREFIX)) {
    return undefined;
  }
  const queueId = actionId.slice(PERMISSIONS_QUEUE_CANCEL_ACTION_PREFIX.length);
  if (!queueId) {
    return undefined;
  }
  return { queueId };
}

function readQueuedTurnAction(
  event: MessagingInboundCallbackEvent,
): QueuedTurnAction | undefined {
  const actionId = event.actionId ?? event.interaction.id;
  const steerPrefix = "queued-turn:steer:";
  if (actionId.startsWith(steerPrefix)) {
    return {
      kind: "steer",
      entryId: actionId.slice(steerPrefix.length),
    };
  }

  const cancelPrefix = "queued-turn:cancel:";
  if (actionId.startsWith(cancelPrefix)) {
    return {
      kind: "cancel",
      entryId: actionId.slice(cancelPrefix.length),
    };
  }

  return undefined;
}

function handoffContextForBinding(
  binding: MessagingBindingRecord,
  navigation: NavigationSnapshot,
): MessagingWorkspaceHandoffContext | undefined {
  const thread = findThreadForBinding(navigation, binding);
  if (!thread) {
    return undefined;
  }

  const worktreeDirectory = thread.linkedDirectories.find(
    (directory) => directory.kind === "worktree" || Boolean(directory.worktreePath),
  );
  if (worktreeDirectory) {
    const repositoryPath = worktreeDirectory.path;
    const workingDirectoryPath = worktreeDirectory.worktreePath ?? worktreeDirectory.path;
    const branch = thread.observedGitBranch ?? thread.gitBranch;
    if (!repositoryPath || !workingDirectoryPath || !branch) {
      return undefined;
    }
    return {
      backend: binding.backend,
      branch,
      leaveLocalBranches: [],
      projectLabel: worktreeDirectory.label,
      repositoryPath,
      threadId: binding.threadId,
      threadTitle: thread.title,
      workingDirectoryPath,
      workspaceKind: "worktree",
    };
  }

  const localDirectory =
    thread.linkedDirectories.find((directory) => directory.kind === "local") ??
    thread.linkedDirectories[0];
  if (!localDirectory?.path) {
    return undefined;
  }
  const directorySummary = findNavigationDirectory(navigation, localDirectory);
  const branch =
    thread.observedGitBranch ??
    thread.gitBranch ??
    directorySummary?.gitStatus?.currentBranch;
  if (!branch) {
    return undefined;
  }
  const leaveLocalBranches = (
    directorySummary?.gitStatus?.handoffBranches ??
    directorySummary?.gitStatus?.branches?.filter((candidate) => candidate !== branch) ??
    []
  ).filter(
    (candidate, index, branches) =>
      candidate !== branch && branches.indexOf(candidate) === index,
  );
  if (leaveLocalBranches.length === 0) {
    return undefined;
  }

  return {
    backend: binding.backend,
    branch,
    leaveLocalBranches,
    projectLabel: localDirectory.label,
    repositoryPath: localDirectory.path,
    threadId: binding.threadId,
    threadTitle: thread.title,
    workingDirectoryPath: localDirectory.path,
    workspaceKind: "local",
  };
}

function handoffBranchPageIndexFromValue(value: MessagingJsonValue | undefined): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return 0;
  }
  const pageIndex = value.pageIndex;
  return typeof pageIndex === "number" && Number.isFinite(pageIndex)
    ? Math.max(0, Math.trunc(pageIndex))
    : 0;
}

function findNavigationDirectory(
  navigation: NavigationSnapshot,
  linkedDirectory: LinkedDirectorySummary,
): NavigationDirectorySummary | undefined {
  return navigation.directories.find(
    (directory) =>
      directory.key === linkedDirectory.id ||
      directory.path === linkedDirectory.path ||
      (linkedDirectory.worktreePath && directory.path === linkedDirectory.worktreePath),
  );
}

function validateHandoffRequest(
  request: HandoffThreadWorkspaceRequest,
  context: MessagingWorkspaceHandoffContext,
): { valid: true } | { valid: false; reason: string } {
  const expectedDirection =
    context.workspaceKind === "local" ? "local-to-worktree" : "worktree-to-local";
  if (
    request.backend !== context.backend ||
    request.threadId !== context.threadId ||
    request.direction !== expectedDirection ||
    request.repositoryPath !== context.repositoryPath ||
    request.sourcePath !== context.workingDirectoryPath
  ) {
    return {
      valid: false,
      reason: "That handoff prompt is stale. Use /status to refresh.",
    };
  }
  if (context.branch && request.sourceBranch !== context.branch) {
    return {
      valid: false,
      reason: "The thread branch changed. Use /status to refresh before handoff.",
    };
  }
  if (request.direction === "local-to-worktree") {
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
  return direction === "local-to-worktree"
    ? "Local to new worktree"
    : "Worktree to Local";
}

function handoffSuccessText(result: HandoffThreadWorkspaceResponse): string {
  return [
    `Workspace handoff complete: ${formatHandoffDirection(result.direction)}.`,
    `Workspace: ${result.workMode === "worktree" ? "Worktree" : "Local"}`,
    `Target: ${result.targetPath}`,
    result.branch ? `Branch: ${result.branch}` : undefined,
    ...result.warnings.map((warning) => `Warning: ${warning}`),
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function normalizeConversationTitle(title: string | undefined): string | undefined {
  const normalized = title?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function conversationKindLabel(kind: MessagingBindingRecord["channel"]["conversation"]["kind"]): string {
  switch (kind) {
    case "topic":
      return "topic";
    case "thread":
      return "thread";
    case "channel":
      return "channel";
    case "dm":
      return "conversation";
  }
}

function threadIdForBackendEvent(event: AgentEvent): ThreadIdentifier | undefined {
  const params = event.notification.params as { threadId?: unknown };
  return typeof params.threadId === "string" ? params.threadId : undefined;
}

function turnIdForBackendEvent(event: AgentEvent): string | undefined {
  const params = event.notification.params as {
    turn?: { id?: unknown };
    turnId?: unknown;
  };
  if (typeof params.turnId === "string") {
    return params.turnId;
  }
  return typeof params.turn?.id === "string" ? params.turn.id : undefined;
}

function isTerminalTurnLifecycle(
  lifecycle: MessagingActiveTurnSummary | undefined,
): boolean {
  return Boolean(
    lifecycle &&
      ["completed", "failed", "interrupted"].includes(lifecycle.status),
  );
}

function isSameActiveTurnState(
  previous: MessagingActiveTurnSummary | undefined,
  next: MessagingActiveTurnSummary | undefined,
): boolean {
  return Boolean(
    previous &&
      next &&
      previous.turnId === next.turnId &&
      previous.status === next.status,
  );
}

function isThreadNameUpdatedEvent(event: AgentEvent): boolean {
  return event.notification.method === "thread/name/updated";
}

function shouldFlushToolUpdatesBeforeIntent(intent: MessagingSurfaceIntent): boolean {
  if (intent.kind === "activity" || intent.kind === "dismiss") {
    return false;
  }
  if (
    intent.kind === "message" &&
    intent.role === "system" &&
    intent.id.startsWith("tool-update")
  ) {
    return false;
  }
  return true;
}

function assistantTextForBackendEvent(event: AgentEvent): string | undefined {
  if (event.notification.method === "item/completed") {
    const params = event.notification.params as {
      item?: {
        text?: unknown;
        type?: unknown;
      };
    };
    if (params.item?.type !== "agentMessage" || typeof params.item.text !== "string") {
      return undefined;
    }
    return params.item.text.trim() || undefined;
  }

  if (event.notification.method === "turn/completed") {
    const params = event.notification.params as {
      turn?: {
        output?: unknown;
      };
    };
    if (!Array.isArray(params.turn?.output)) {
      return undefined;
    }
    const text = params.turn.output
      .map((item) =>
        item && typeof item === "object" && "text" in item
          ? (item as { text?: unknown }).text
          : undefined,
      )
      .filter((value): value is string => typeof value === "string")
      .join("\n\n")
      .trim();
    return text || undefined;
  }

  return undefined;
}

function assistantDeltaForBackendEvent(
  event: AgentEvent,
): AssistantStreamDelta | undefined {
  if (event.notification.method !== "item/agentMessage/delta") {
    return undefined;
  }
  const params = event.notification.params as {
    delta?: unknown;
    itemId?: unknown;
    threadId?: unknown;
    turnId?: unknown;
  };
  if (
    typeof params.threadId !== "string" ||
    typeof params.itemId !== "string" ||
    typeof params.delta !== "string" ||
    params.delta.length === 0
  ) {
    return undefined;
  }
  const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
  return {
    delta: params.delta,
    itemId: params.itemId,
    streamKey: assistantStreamKey({
      backend: event.backend,
      threadId: params.threadId,
      turnId,
    }),
    threadId: params.threadId,
    turnId,
  };
}

function assistantStreamKeysForBackendEvent(event: AgentEvent): string[] {
  const params = event.notification.params as {
    threadId?: unknown;
    turn?: { id?: unknown };
    turnId?: unknown;
  };
  if (typeof params.threadId !== "string") {
    return [];
  }
  const turnId =
    typeof params.turnId === "string"
      ? params.turnId
      : typeof params.turn?.id === "string"
        ? params.turn.id
        : undefined;
  return [
    assistantStreamKey({
      backend: event.backend,
      threadId: params.threadId,
      turnId,
    }),
  ];
}

function assistantStreamFilterForBackendEvent(
  event: AgentEvent,
): { threadId: ThreadIdentifier; turnId?: string } | undefined {
  const params = event.notification.params as {
    threadId?: unknown;
    turn?: { id?: unknown };
    turnId?: unknown;
  };
  if (typeof params.threadId !== "string") {
    return undefined;
  }
  return {
    threadId: params.threadId,
    turnId: typeof params.turnId === "string"
      ? params.turnId
      : typeof params.turn?.id === "string"
        ? params.turn.id
        : undefined,
  };
}

function assistantStreamKey(params: {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  turnId?: string;
}): string {
  return [
    params.backend,
    params.threadId,
    params.turnId ?? "",
    "assistant-text",
  ].join(":");
}

function compactLogPreview(text: string, limit = 96): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const preview = compact.length > limit ? `${compact.slice(0, limit - 3)}...` : compact;
  return preview.replace(/["\\]/g, "\\$&");
}

function buildQueuedInputPreview(parts: string[]): string {
  const preview = parts
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  return preview || "[attachment]";
}

function buildQueuedTurnNoticeBody(preview: string, canSteer: boolean): string {
  const quotedPreview = truncateText(preview, 500)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const steeringSentence = canSteer
    ? " To submit it as a steering message, click Steer."
    : "";
  return `${quotedPreview}\n\nI got your message, but there is a turn in progress. I've queued it to be sent when the turn completes.${steeringSentence} You can cancel if you don't want this queued.`;
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function isTurnInProgressStartError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(active turn|turn already|already active|in progress)\b/i.test(message);
}

function isPermanentMessagingTargetFailure(result: MessagingDeliveryResult): boolean {
  return (
    result.outcome === "failed" &&
    Boolean(result.errorMessage?.match(/\bUnknown Channel\b|chat not found/i))
  );
}

function isVisibleAssistantStreamDelivery(result: MessagingDeliveryResult): boolean {
  return (
    result.outcome === "presented" ||
    result.outcome === "presented_new" ||
    result.outcome === "updated" ||
    result.outcome === "pinned"
  );
}

function assistantMessageDeliveryKey(event: AgentEvent, text: string): string {
  const params = event.notification.params as {
    threadId?: unknown;
    turn?: { id?: unknown };
    turnId?: unknown;
  };
  const threadId = typeof params.threadId === "string" ? params.threadId : "";
  const turnId =
    typeof params.turnId === "string"
      ? params.turnId
      : typeof params.turn?.id === "string"
        ? params.turn.id
        : "";
  return [
    event.backend,
    threadId,
    turnId,
    createHash("sha256").update(text).digest("base64url"),
  ].join("\0");
}

function isThreadStatusIdleEvent(event: AgentEvent): boolean {
  if (event.notification.method !== "thread/status/changed") {
    return false;
  }
  const params = event.notification.params as {
    status?: {
      type?: unknown;
    };
  };
  return params.status?.type === "idle";
}

function isTurnWorkActivityEvent(
  event: AgentEvent,
  activeTurn: MessagingActiveTurnSummary,
): boolean {
  const params = event.notification.params as {
    turn?: {
      id?: unknown;
    };
    turnId?: unknown;
  };
  const turnId =
    typeof params.turnId === "string"
      ? params.turnId
      : typeof params.turn?.id === "string"
        ? params.turn.id
        : undefined;
  if (turnId !== activeTurn.turnId) {
    return false;
  }

  return (
    event.notification.method.startsWith("item/") ||
    event.notification.method.startsWith("turn/") ||
    event.notification.method.startsWith("thread/")
  );
}

function turnLifecycleForBackendEvent(
  event: AgentEvent,
  now: number,
): MessagingActiveTurnSummary | undefined {
  switch (event.notification.method) {
    case "turn/started": {
      const params = event.notification.params as TurnLifecycleParams;
      const turnId = params.turnId ?? params.turn?.id;
      if (!turnId) {
        return undefined;
      }
      return {
        turnId,
        status: "working",
        startedAt: params.turn?.startedAt ?? undefined,
        updatedAt: now,
      };
    }
    case "turn/completed": {
      const params = event.notification.params as TurnLifecycleParams;
      const turnId = params.turnId ?? params.turn?.id;
      if (!turnId) {
        return undefined;
      }
      return {
        turnId,
        status: "completed",
        startedAt: params.turn?.startedAt ?? undefined,
        updatedAt: now,
      };
    }
    case "turn/failed": {
      const params = event.notification.params as TurnLifecycleParams;
      const turnId = params.turnId ?? params.turn?.id;
      if (!turnId) {
        return undefined;
      }
      return {
        turnId,
        status: "failed",
        startedAt: params.turn?.startedAt ?? undefined,
        updatedAt: now,
      };
    }
    case "turn/cancelled": {
      const params = event.notification.params as TurnLifecycleParams;
      const turnId = params.turnId ?? params.turn?.id;
      if (!turnId) {
        return undefined;
      }
      return {
        turnId,
        status: "interrupted",
        startedAt: params.turn?.startedAt ?? undefined,
        updatedAt: now,
      };
    }
    default:
      return undefined;
  }
}

type TurnLifecycleParams = {
  turnId?: string | null;
  turn?: {
    id?: string | null;
    startedAt?: number | null;
  };
};

function navigationWithStartedThread(params: {
  backend: AppServerBackendKind;
  directory?: NavigationDirectorySummary;
  executionMode?: ThreadExecutionMode;
  navigation: NavigationSnapshot;
  now: number;
  preferences?: MessagingBrowseSessionRecord["preferences"];
  project: NonNullable<ReturnType<typeof selectProjectFromValue>>;
  threadId: ThreadIdentifier;
}): NavigationSnapshot {
  const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
  if (
    params.navigation.threads.some(
      (thread) => thread.source === params.backend && thread.id === params.threadId,
    )
  ) {
    return params.navigation;
  }

  const directoryPath = params.directory?.path ?? params.project.path;
  const linkedDirectory: LinkedDirectorySummary | undefined = directoryPath
    ? {
        id: params.directory?.key ?? directoryPath,
        kind: "local",
        label: params.directory?.label ?? params.project.label,
        path: directoryPath,
      }
    : undefined;

  return {
    ...params.navigation,
    unchanged: false,
    threads: [
      {
        id: params.threadId,
        source: params.backend,
        title: params.threadId,
        titleSource: "fallback",
        projectKey: directoryPath,
        createdAt: params.now,
        updatedAt: params.now,
        executionMode: params.executionMode,
        model: params.preferences?.model ?? params.navigation.launchpadDefaults.model,
        reasoningEffort:
          params.preferences?.reasoningEffort ??
          params.navigation.launchpadDefaults.reasoningEffort,
        serviceTier:
          params.preferences?.serviceTier ?? params.navigation.launchpadDefaults.serviceTier,
        fastMode:
          params.preferences?.fastMode ?? params.navigation.launchpadDefaults.fastMode,
        linkedDirectories: linkedDirectory ? [linkedDirectory] : [],
        inbox: {
          inInbox: true,
          reason: "new-thread",
        },
      },
      ...params.navigation.threads,
    ],
    directories: params.navigation.directories.map((directory) =>
      directory.key === params.directory?.key
        ? {
            ...directory,
            threadKeys: directory.threadKeys.includes(threadKey)
              ? directory.threadKeys
              : [threadKey, ...directory.threadKeys],
            latestUpdatedAt: Math.max(directory.latestUpdatedAt ?? 0, params.now),
          }
        : directory,
    ),
    inboxThreadKeys: params.navigation.inboxThreadKeys.includes(threadKey)
      ? params.navigation.inboxThreadKeys
      : [threadKey, ...params.navigation.inboxThreadKeys],
  };
}

function parseTextCommand(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  return trimmed.slice(1).split(/\s+/, 1)[0]?.toLowerCase();
}

function parseTextCommandArgs(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return [];
  }

  return trimmed.slice(1).split(/\s+/).slice(1).filter(Boolean);
}

function isToolsFallbackText(text: string): boolean {
  return text.trim().toLowerCase() === "tools";
}

function readBindingTarget(
  event: MessagingInboundCallbackEvent,
): { backend: AppServerBackendKind; threadId: ThreadIdentifier } | undefined {
  const fromValue = readBindingTargetFromValue(event.value);
  if (fromValue) {
    return fromValue;
  }

  const actionId = event.actionId ?? event.interaction.id;
  const match = /^bind:(codex|grok):(.+)$/.exec(actionId);
  if (!match) {
    return undefined;
  }

  return {
    backend: match[1] as AppServerBackendKind,
    threadId: match[2]!,
  };
}

function readBindingTargetFromValue(
  value: MessagingJsonValue | undefined,
): { backend: AppServerBackendKind; threadId: ThreadIdentifier } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const backend = value.backend;
  const threadId = value.threadId;
  if ((backend === "codex" || backend === "grok") && typeof threadId === "string") {
    return {
      backend,
      threadId,
    };
  }

  return undefined;
}

function readStringValue(
  value: MessagingJsonValue | undefined,
  key: string,
): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const result = value[key];
  return typeof result === "string" ? result : undefined;
}

function describeOutboundIntent(intent: MessagingSurfaceIntent): string {
  if (intent.kind === "message") {
    const role = (intent as MessagingMessageIntent).role ?? "assistant";
    return role === "assistant"
      ? "Sent assistant reply"
      : `Sent ${role} message`;
  }
  if (intent.kind === "approval") return "Sent approval request";
  if (intent.kind === "error") return "Sent error notice";
  return `Sent ${intent.kind}`;
}
