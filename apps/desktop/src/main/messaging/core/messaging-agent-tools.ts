import type { MessagingAgentToolContext } from "./messaging-agent-tool-context";
import { agentMessagingTurnKey, type ActiveAgentMessagingOrigin } from "./messaging-backend-event-helpers";
import { containedMessagingBindingMatches } from "@pwragent/shared/contained-messaging";
import { randomUUID } from "node:crypto";
import { isAppServerBackendKind } from "@pwragent/shared/contracts/navigation";
import { isMessagingBindingTargetKind } from "@pwragent/shared/contracts/messaging";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type {
  AppServerBackendKind,
  ThreadIdentifier,
} from "@pwragent/shared/contracts/normalized-app-server";
import type {
  PwrAgentMessagingConversationCapabilitiesSummary,
  PwrAgentMessagingLocationSummary,
  PwrAgentMessagingManagedConversationSummary,
  PwrAgentMessagingOutboundAttachmentSummary,
  PwrAgentMessagingRequest,
  PwrAgentMessagingResponse,
  ListMessagingSurfacesResult,
} from "@pwragent/shared/contracts/messaging-tools";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { MessagingRequestSource } from "./messaging-storage";
import type { MessagingBindingRecord, MessagingChannelRef, MessagingInboundEvent, MessagingImagePart, MessagingPrivateConversationResolveResult } from "@pwragent/messaging-interface";
import { resolveMessagingOutboundFile, resolveMessagingOutboundBytes, validateMessagingFileMetadata, type MessagingOutboundFileAccess } from "./messaging-outbound-file.js";
import { resolveScratchProjectsRoots } from "../../app-server/scratch-projects.js";
import { MessagingFederatedThreadTargetError } from "./messaging-adapter.js";
import { buildConfirmationIntent } from "./messaging-renderer.js";
import { type MessagingNavigationContext, type MessagingThreadContext } from "./messaging-thread-state.js";
import { OriginalAttachmentError, type OriginalAttachmentConsumer } from "./messaging-original-attachment-store.js";
import { normalizeConversationTitle } from "./messaging-binding-helpers";
import { originalAttachmentActorKey } from "./messaging-inbound-helpers";
import { PRIVATE_REPLY_CONTINUATION_TTL_MS, type AgentMessagingOriginResolution, type AttachTargetResolution, attachTargetNotFound, readPdfToolString, readOptionalPositiveInteger, readPdfToolPageNumbers, pdfToolFailure, assistantImageDeliverySignature, outboundImageClaimAliases, privateReplySourceFromBinding, summarizeMessagingConversation, summarizeMessagingActor, summarizeMessagingBinding, isMessagingToolOriginBinding, summarizeNavigationThreadForMessaging, responseAttributionLabel, eventFromBinding, sanitizeMessagingChildTitle, managedConversationUnavailableMessage, isVisibleAssistantStreamDelivery } from "./messaging-agent-tool-helpers";

export class MessagingAgentTools {
  constructor(private readonly context: MessagingAgentToolContext) {}

  async handlePwrAgentMessagingRequest(
    request: PwrAgentMessagingRequest,
    receivedFile?: Uint8Array,
    consumeOriginal?: OriginalAttachmentConsumer,
  ): Promise<PwrAgentMessagingResponse> {
    switch (request.operation) {
      case "list_messaging_attachments":
      case "export_messaging_attachment":
        return await this.handleOriginalAttachmentRequest(request, consumeOriginal);
      case "list_messaging_surfaces":
        return await this.listRetainedMessagingSurfaces(request);
      case "attach_thread_to_surface":
        return await this.attachThreadToRetainedSurface(request);
      case "get_current_location":
      case "get_current_messaging_surface": {
        const origin = await this.resolveAgentMessagingOrigin(request.context);
        if (!origin.ok) {
          return origin;
        }
        return {
          ok: true,
          data: {
            location: await this.summarizeAgentMessagingLocation(origin.origin),
          },
        };
      }
      case "rename_current_messaging_conversation":
        return await this.renameCurrentMessagingConversationFromAgentMessagingOrigin(
          request,
        );
      case "send_private_response":
        return await this.sendPrivateResponseFromAgentMessagingOrigin(request);
      case "send_messaging_file":
        return await this.sendMessagingFileFromAgentMessagingOrigin(request, receivedFile);
      case "attach_thread_here":
        return await this.attachThreadHereFromAgentMessagingOrigin(request);
      case "inspect_messaging_pdfs":
        return await this.inspectMessagingPdfsFromAgentMessagingOrigin(request);
      case "search_messaging_pdf_text":
        return await this.searchMessagingPdfTextFromAgentMessagingOrigin(request);
      case "render_messaging_pdf_pages":
        return await this.renderMessagingPdfPagesFromAgentMessagingOrigin(request);
    }
  }

  retainedSourceUnavailable(context: PwrAgentMessagingRequest["context"], code: "forbidden" | "not_found" = "forbidden"): Extract<PwrAgentMessagingResponse, { ok: false }> {
    return { ok: false, error: {
      code: context.causalMessagingAmbiguous ? "ambiguous_location" : code,
      message: context.causalMessagingAmbiguous
        ? "This turn combines different causal messaging requests; choose a separately attributable request before attaching."
        : "No currently authorized human messaging request is available for this operation. Saved bindings do not establish the requesting actor.",
    } };
  }

  async listRetainedMessagingSurfaces(
    request: Extract<PwrAgentMessagingRequest, { operation: "list_messaging_surfaces" }>,
  ): Promise<PwrAgentMessagingResponse> {
    const source = this.context.host().retainedRequestSource(request.context);
    if (!source || !this.context.host().isChannelInScope(source.event.channel)) return this.retainedSourceUnavailable(request.context, "not_found");
    if (!this.context.host().retainedRequestCanCrossInstance(request.context, source) || !this.context.config.requestStore || !this.context.host().retainedSourceHasPermissions(source)
      || !await this.context.host().retainedSourceIsAuthorized(source)) return this.retainedSourceUnavailable(request.context);
    if (!isAppServerBackendKind(request.args.backend) || !request.args.threadId?.trim()
      || (request.args.limit !== undefined && (!Number.isInteger(request.args.limit) || request.args.limit < 1 || request.args.limit > 25))) {
      return { ok: false, error: { code: "invalid_arguments", message: "Provide a target backend/threadId and a limit between 1 and 25." } };
    }
    const canUseRemote = this.context.host().actorHasPermission(source.event, "federation.remote_control");
    if (request.args.instanceId && !canUseRemote) return this.retainedSourceUnavailable(request.context);
    const target = await this.resolveAttachTarget({ ...request.args, includeRemote: canUseRemote && request.args.includeRemote !== false });
    if (!target.ok) return target;
    let before: { at: number; selector: string } | undefined;
    if (request.args.cursor) {
      try {
        if (request.args.cursor.length > 512) throw new Error("oversized cursor");
        const cursor = JSON.parse(Buffer.from(request.args.cursor, "base64url").toString("utf8")) as { scope: string; at: number; selector: string };
        if (cursor.scope !== source.principalScope || !Number.isSafeInteger(cursor.at) || !/^[a-f0-9]{64}$/.test(cursor.selector)) throw new Error("invalid cursor");
        before = cursor;
      } catch {
        return { ok: false, error: { code: "invalid_arguments", message: "Use an unmodified nextCursor from this request's destination listing." } };
      }
    }
    const limit = request.args.limit ?? 25;
    const candidates = this.context.config.requestStore.list(source, limit + 1, before);
    const page = candidates.slice(0, limit);
    const result: ListMessagingSurfacesResult = {
      surfaces: [], eligibleCount: null, countIsComplete: !before && candidates.length <= limit,
      selectionReason: "unavailable",
    };
    for (const candidate of page) {
      if (!this.context.host().retainedSourceHasPermissions(candidate)) continue;
      const authorized = await this.context.host().retainedSourceIsAuthorized(candidate);
      if (authorized === undefined) result.countIsComplete = false;
      if (!authorized) continue;
      // Use the immutable request's reply anchor for its causal destination,
      // even if a later human interaction updated this surface's summary.
      const selected = candidate.selector === source.selector ? source : candidate;
      const origin = await this.originForRetainedSource(selected);
      const location = await this.summarizeAgentMessagingLocation(origin, { navigation: { kind: "thread", thread: target.thread } });
      if (location.managedConversation.outcome === "failed") result.countIsComplete = false;
      if (!this.resolveAttachPlacement({ location, origin, placement: request.args.placement ?? "auto" }).ok) continue;
      result.surfaces.push({ surfaceSelector: candidate.selector, location,
        revision: selected.ref.requestId,
        lastUserInteractionAt: candidate.event.receivedAt, route: candidate.route,
        provenance: candidate.selector === source.selector ? "causal_request" : "last_human_interaction" });
    }
    if (result.countIsComplete) result.eligibleCount = result.surfaces.length;
    if (candidates.length > limit && page.length) {
      const last = page[page.length - 1]!;
      result.nextCursor = Buffer.from(JSON.stringify({ scope: source.principalScope,
        at: last.event.receivedAt, selector: last.selector })).toString("base64url");
    }
    // Recommendation does not reorder the human-recency list and does not
    // require enumerating every surface on the normal causal attach path.
    const origin = await this.originForRetainedSource(source);
    const location = await this.summarizeAgentMessagingLocation(origin, { navigation: { kind: "thread", thread: target.thread } });
    if (this.resolveAttachPlacement({ location, origin, placement: request.args.placement ?? "auto" }).ok) {
      result.recommendedSurfaceSelector = source.selector;
      result.selectionReason = "causal_request";
    } else if (result.surfaces.length) {
      if (result.countIsComplete && result.surfaces.length === 1) {
        result.selectionReason = "sole_eligible";
        result.recommendedSurfaceSelector = result.surfaces[0]!.surfaceSelector;
      } else result.selectionReason = "ambiguous";
    } else if (result.countIsComplete) result.selectionReason = "none";
    return { ok: true, data: result };
  }

  async originForRetainedSource(source: MessagingRequestSource): Promise<ActiveAgentMessagingOrigin> {
    return { source, event: source.event,
      binding: source.bindingId ? await this.context.store.getBinding(source.bindingId) : undefined };
  }

  async attachThreadToRetainedSurface(
    request: Extract<PwrAgentMessagingRequest, { operation: "attach_thread_to_surface" }>,
  ): Promise<PwrAgentMessagingResponse> {
    const source = this.context.host().retainedRequestSource(request.context);
    if (!source || !this.context.host().isChannelInScope(source.event.channel)) return this.retainedSourceUnavailable(request.context, "not_found");
    if (!this.context.host().retainedRequestCanCrossInstance(request.context, source) || !this.context.host().retainedSourceHasPermissions(source)
      || !await this.context.host().retainedSourceIsAuthorized(source, false)) return this.retainedSourceUnavailable(request.context);
    if (request.args.instanceId && !this.context.host().actorHasPermission(source.event, "federation.remote_control")) return this.retainedSourceUnavailable(request.context);
    let selector = request.args.surfaceSelector;
    if (request.args.selection !== undefined && !["causal", "sole_eligible"].includes(request.args.selection)) {
      return { ok: false, error: { code: "invalid_arguments", message: "selection must be causal or sole_eligible." } };
    }
    if (request.args.selection === "sole_eligible") {
      if (selector) return { ok: false, error: { code: "invalid_arguments", message: "Choose an explicit surfaceSelector or sole_eligible selection, not both." } };
      const listed = await this.listRetainedMessagingSurfaces({ operation: "list_messaging_surfaces", context: request.context,
        args: { ...request.args, limit: 25 } });
      if (!listed.ok) return listed;
      if (!("surfaces" in listed.data) || !listed.data.countIsComplete || listed.data.eligibleCount !== 1) {
        return { ok: false, error: { code: "ambiguous_location", message: "Sole-surface selection requires a complete authorized candidate set with exactly one eligible destination. Inspect and select a destination explicitly." } };
      }
      selector = listed.data.surfaces[0]!.surfaceSelector;
    }
    const selected = !selector || selector === source.selector ? source
      : this.context.config.requestStore?.destination(source, selector);
    if (!selected || !this.context.host().retainedSourceHasPermissions(selected)
      || !await this.context.host().retainedSourceIsAuthorized(selected, false)) return this.retainedSourceUnavailable(request.context);
    if (request.args.expectedRevision && request.args.expectedRevision !== selected.ref.requestId) {
      return { ok: false, error: { code: "forbidden", message: "The selected destination's human reply anchor changed. Inspect its current revision before attaching." } };
    }
    if (request.args.idempotencyKey !== undefined && (typeof request.args.idempotencyKey !== "string"
      || !request.args.idempotencyKey || request.args.idempotencyKey.length > 128)) {
      return { ok: false, error: { code: "invalid_arguments", message: "idempotencyKey must contain 1 to 128 characters." } };
    }
    const claim = this.context.config.requestStore?.claimAttachment([source.ref.requestId, selected.selector,
      request.args.backend, request.args.threadId, request.args.instanceId ?? null,
      request.args.placement ?? "auto", request.args.targetKind ?? "thread", request.args.title ?? null,
      request.args.idempotencyKey ?? null]);
    if (!claim) return this.retainedSourceUnavailable(request.context);
    if (!claim.claimed) {
      if (!await this.context.host().retainedSourceIsAuthorized(selected)) return this.retainedSourceUnavailable(request.context);
      if (claim.result?.ok && "binding" in claim.result.data) {
        const binding = await this.context.store.getBinding(claim.result.data.binding.id);
        if (!binding || binding.revokedAt) return this.retainedSourceUnavailable(request.context);
      }
      return claim.result ?? { ok: false, error: { code: "internal_error",
        message: "This attachment was already claimed and its provider outcome is unresolved. Reconcile it before retrying; no second conversation was created." } };
    }
    const result = await this.attachThreadHereFromAgentMessagingOrigin({
      operation: "attach_thread_here", context: request.context,
      args: { ...request.args, includeRemote: this.context.host().actorHasPermission(source.event, "federation.remote_control") && request.args.includeRemote !== false },
    }, await this.originForRetainedSource(selected));
    this.context.config.requestStore!.finishAttachment(claim.id, result);
    return result;
  }

  async attachThreadHereFromAgentMessagingOrigin(
    request: Extract<PwrAgentMessagingRequest, { operation: "attach_thread_here" }>,
    retainedOrigin?: ActiveAgentMessagingOrigin,
  ): Promise<PwrAgentMessagingResponse> {
    const { args } = request;
    if (
      !args ||
      !isAppServerBackendKind(args.backend) ||
      typeof args.threadId !== "string" ||
      args.threadId.trim().length === 0
    ) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: "attach_thread_here requires backend and threadId.",
        },
      };
    }
    const instanceId = args.instanceId?.trim();
    const includeRemote = args.includeRemote !== false;
    if (Object.hasOwn(args, "instanceId") && !instanceId) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: "instanceId must be a non-empty string when provided.",
        },
      };
    }
    if (instanceId && !includeRemote) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: "instanceId cannot be used when includeRemote is false.",
        },
      };
    }
    const placement = args.placement ?? "auto";
    if (
      placement !== "auto" &&
      placement !== "new_child" &&
      placement !== "current_conversation"
    ) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: "placement must be auto, new_child, or current_conversation.",
        },
      };
    }
    const targetKind = args.targetKind ?? "thread";
    if (!isMessagingBindingTargetKind(targetKind)) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: "targetKind must be thread or agent_thread.",
        },
      };
    }

    const origin = retainedOrigin ? { ok: true as const, origin: retainedOrigin }
      : await this.resolveAgentMessagingOrigin(request.context);
    if (!origin.ok) {
      return origin;
    }
    const target = await this.resolveAttachTarget({
      backend: args.backend,
      threadId: args.threadId,
      ...(instanceId ? { instanceId } : {}),
      includeRemote,
    });
    if (!target.ok) {
      return target;
    }

    if (!await this.context.host().requireRemoteScope(origin.origin.event, target.federatedThread?.target, "agent-attach:remote-instance", { notify: false })) {
      return { ok: false, error: { code: "forbidden", message: "The requesting actor cannot attach a thread from this instance." } };
    }

    const location = await this.summarizeAgentMessagingLocation(origin.origin, {
      navigation: { kind: "thread", thread: target.thread },
    });
    const resolvedPlacement = this.resolveAttachPlacement({
      location,
      origin: origin.origin,
      placement,
    });
    if (!resolvedPlacement.ok) {
      return resolvedPlacement;
    }

    let attachEvent = origin.origin.event;
    let createdConversation: MessagingChannelRef["conversation"] | undefined;
    if (retainedOrigin?.source && (!this.context.host().retainedSourceHasPermissions(retainedOrigin.source)
      || !await this.context.host().retainedSourceIsAuthorized(retainedOrigin.source))) return this.retainedSourceUnavailable(request.context);
    if (resolvedPlacement.placement === "new_child") {
      if (!this.context.adapter.createManagedConversation) {
        return {
          ok: false,
          error: {
            code: "unsupported_operation",
            message:
              "This messaging provider does not support creating a native child conversation from PwrAgent.",
          },
        };
      }
      const createResult = await this.context.adapter.createManagedConversation({
        actor: origin.origin.event.actor,
        parent: origin.origin.event.channel,
        routingState: origin.origin.event.routingState,
        sourceSurface: origin.origin.event.sourceSurface,
        title: sanitizeMessagingChildTitle(args.title),
      });
      if (createResult.outcome !== "created" || !createResult.conversation) {
        return {
          ok: false,
          error: {
            code: createResult.outcome === "unsupported"
              ? "unsupported_operation"
              : "internal_error",
            message:
              createResult.errorMessage ??
              "The messaging provider could not create a native child conversation.",
          },
        };
      }
      createdConversation = createResult.conversation;
      attachEvent = {
        ...origin.origin.event,
        id: `${origin.origin.event.id}:attach:${this.context.now()}`,
        kind: "lifecycle",
        lifecycle: "bound",
        channel: {
          channel: createResult.channel,
          conversation: createResult.conversation,
        },
        routingState: createResult.routingState,
        receivedAt: this.context.now(),
      };
    }

    if (retainedOrigin?.source && (!this.context.host().retainedSourceHasPermissions(retainedOrigin.source)
      || !await this.context.host().retainedSourceIsAuthorized(retainedOrigin.source))) return this.retainedSourceUnavailable(request.context);
    const binding = await this.context.host().bindChannelToThread(attachEvent, {
      backend: args.backend,
      federatedThread: target.federatedThread,
      threadId: args.threadId,
      targetKind,
    });
    await this.context.host().restoreAttachedTurnActivity(binding);
    const visibleBinding = await this.context.host().renderBindingStatus(binding);
    await this.context.host().repostLastAssistantMessageForResume(visibleBinding, {
      important: true,
    });
    return {
      ok: true,
      data: {
        binding: summarizeMessagingBinding(
          visibleBinding,
          summarizeNavigationThreadForMessaging(target.thread),
        ),
        channel: visibleBinding.channel.channel,
        conversation: summarizeMessagingConversation(visibleBinding.channel.conversation),
        createdConversation: createdConversation
          ? summarizeMessagingConversation(createdConversation)
          : undefined,
        location,
        outcome: resolvedPlacement.placement === "new_child"
          ? "created_and_attached"
          : "attached",
        placement: resolvedPlacement.placement,
      },
    };
  }

  async renameCurrentMessagingConversationFromAgentMessagingOrigin(
    request: Extract<
      PwrAgentMessagingRequest,
      { operation: "rename_current_messaging_conversation" }
    >,
  ): Promise<PwrAgentMessagingResponse> {
    const title = normalizeConversationTitle(
      typeof request.args?.title === "string" ? request.args.title : undefined,
    );
    if (!title || title.length > 200) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message:
            "rename_current_messaging_conversation requires title between 1 and 200 characters.",
        },
      };
    }
    const origin = await this.resolveAgentMessagingOrigin(request.context);
    if (!origin.ok) {
      return origin;
    }
    if (!this.context.adapter.setConversationTitle) {
      return {
        ok: false,
        error: {
          code: "unsupported_operation",
          message:
            "This messaging provider does not support renaming the current conversation.",
        },
      };
    }

    const result = await this.context.adapter.setConversationTitle({
      actor: origin.origin.event.actor,
      channel: origin.origin.event.channel,
      routingState:
        origin.origin.event.routingState ?? origin.origin.binding?.routingState,
      title,
    });
    if (result.outcome !== "updated") {
      return {
        ok: false,
        error: {
          code: result.outcome === "unsupported"
            ? "unsupported_operation"
            : "internal_error",
          message:
            result.errorMessage
            ?? "The messaging provider could not rename the current conversation.",
        },
      };
    }

    const renamedConversation = {
      ...result.conversation,
      title: result.title,
    };
    if (origin.origin.binding) {
      const updatedBinding = await this.context.store.upsertBinding({
        ...origin.origin.binding,
        channel: {
          ...origin.origin.binding.channel,
          conversation: {
            ...origin.origin.binding.channel.conversation,
            ...renamedConversation,
          },
        },
        updatedAt: result.updatedAt,
      });
      origin.origin.binding = updatedBinding;
      if (origin.origin.deliveryBinding?.id === updatedBinding.id) {
        origin.origin.deliveryBinding = updatedBinding;
      }
      this.context.host().notifyBindingChanged("agent-rename-conversation");
      // Binding-local mutation with no registry event behind it, so the
      // status card needs the inline render too — the bus never fires for
      // this, and the provider's own rename echo (Slack's
      // `agent_session_title_changed`) only fires for a participant's
      // rename, never for ours.
      await this.context.host().renderBindingStatus(updatedBinding, origin.origin.event);
    }

    return {
      ok: true,
      data: {
        channel: result.channel,
        conversation: summarizeMessagingConversation(renamedConversation),
        outcome: "renamed",
        title: result.title,
        updatedAt: result.updatedAt,
      },
    };
  }

  async sendPrivateResponseFromAgentMessagingOrigin(
    request: Extract<
      PwrAgentMessagingRequest,
      { operation: "send_private_response" }
    >,
  ): Promise<PwrAgentMessagingResponse> {
    const text = typeof request.args?.text === "string"
      ? request.args.text
      : "";
    const awaitReply = request.args?.awaitReply === true;
    const replyInstructions = typeof request.args?.replyInstructions === "string"
      ? request.args.replyInstructions.trim()
      : "";
    const suppliedReplyOptions = request.args?.replyOptions;
    const replyOptions = suppliedReplyOptions === undefined
      ? [{ label: "I did it", text: "I did it." }]
      : suppliedReplyOptions;
    if (!text.trim() || text.length > 40_000) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message:
            "send_private_response requires text between 1 and 40,000 characters.",
        },
      };
    }
    if (
      awaitReply
      && (!replyInstructions || replyInstructions.length > 4_000)
    ) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message:
            "send_private_response requires replyInstructions between 1 and 4,000 characters when awaitReply is true.",
        },
      };
    }
    if (
      suppliedReplyOptions !== undefined
      && (
        !awaitReply
        || !Array.isArray(suppliedReplyOptions)
        || suppliedReplyOptions.length < 1
        || suppliedReplyOptions.length > 3
        || suppliedReplyOptions.some((option) =>
          !option
          || typeof option.label !== "string"
          || option.label.trim().length < 1
          || option.label.length > 40
          || typeof option.text !== "string"
          || option.text.trim().length < 1
          || option.text.length > 500
        )
      )
    ) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message:
            "replyOptions requires awaitReply and one to three buttons with a label (1–40 characters) and text (1–500 characters).",
        },
      };
    }
    const actionCapabilities = this.context.capabilityProfile.actions;
    const actionCapacity = actionCapabilities
      ? Math.min(
          actionCapabilities.maxActions,
          (actionCapabilities.maxRows ?? Number.POSITIVE_INFINITY)
            * actionCapabilities.maxActionsPerRow,
        )
      : 0;
    if (
      awaitReply
      && actionCapacity >= 2
      && (
        replyOptions.length + 1 > actionCapacity
        || replyOptions.some((option) =>
          option.label.length > (actionCapabilities?.maxLabelLength ?? 40)
        )
      )
    ) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message:
            `This messaging provider supports at most ${actionCapacity - 1} private reply option(s) plus Cancel; labels must fit its button limit.`,
        },
      };
    }
    if (!request.context.turnId) {
      return {
        ok: false,
        error: {
          code: "not_found",
          message:
            "Private responses require the active messaging turn that identified the requesting user.",
        },
      };
    }
    const turnKey = agentMessagingTurnKey(
      request.context.backend,
      request.context.threadId,
      request.context.turnId,
    );
    const privateReceipt = this.context.privateResponses.beginTool(turnKey);
    try {
      const origin = await this.resolveAgentMessagingOrigin(request.context);
      if (!origin.ok) {
        return origin;
      }
      if (!this.context.adapter.resolvePrivateConversation) {
        return {
          ok: false,
          error: {
            code: "unsupported_operation",
            message:
              "This messaging provider cannot start a private response to the requesting user.",
          },
        };
      }

      let privateConversation: MessagingPrivateConversationResolveResult;
      try {
        privateConversation = await this.context.adapter.resolvePrivateConversation({
          actor: origin.origin.event.actor,
          ...(awaitReply ? { replyContinuationRequired: true } : {}),
          source: origin.origin.event.channel,
          routingState: origin.origin.event.routingState,
        });
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "internal_error",
            message:
              error instanceof Error
                ? `Could not resolve a private conversation: ${error.message}`
                : "Could not resolve a private conversation.",
          },
        };
      }
      if (
        privateConversation.outcome !== "resolved"
        || !privateConversation.conversation
        || privateConversation.channel !== origin.origin.event.channel.channel
      ) {
        return {
          ok: false,
          error: {
            code: privateConversation.outcome === "unsupported"
              ? "unsupported_operation"
              : "internal_error",
            message:
              privateConversation.errorMessage
              ?? "The messaging provider could not resolve a private conversation.",
          },
        };
      }

      const privateEvent: MessagingInboundEvent = {
        ...origin.origin.event,
        id: `${origin.origin.event.id}:private-response:${this.context.now()}`,
        channel: {
          channel: privateConversation.channel,
          conversation: privateConversation.conversation,
        },
        receivedAt: this.context.now(),
        routingState: privateConversation.routingState,
      };
      const sourceBinding = origin.origin.deliveryBinding ?? origin.origin.binding;
      if (awaitReply && !sourceBinding) {
        return {
          ok: false,
          error: {
            code: "unsupported_operation",
            message: "A private reply needs an originating conversation for its completion.",
          },
        };
      }
      const sourceThread = sourceBinding
        ? await this.context.host().resolveBoundThreadSummary(sourceBinding)
        : undefined;
      const attributionLabel = sourceBinding
        ? responseAttributionLabel(sourceBinding, sourceThread)
        : "PwrAgent Agent";
      const requestId = awaitReply ? randomUUID() : undefined;
      // Interactive cards use one provider text block. Keep long private content
      // on the ordinary message path so provider block limits cannot clip it.
      const buttonActions = awaitReply && requestId && actionCapacity >= 2 && text.length <= 2_000
        ? [
            ...replyOptions.map((option, index) => ({
              id: `private-reply:${requestId}:reply:${index}`,
              label: option.label,
              style: "primary" as const,
            })),
            {
              id: `private-reply:${requestId}:cancel`,
              label: "Cancel",
              style: "secondary" as const,
            },
          ]
        : [];
      const result = await this.context.host().deliver(
        buttonActions.length > 0
          ? {
              ...buildConfirmationIntent({
                id: this.context.host().newIntentId("private-response"),
                capabilityProfile: this.context.capabilityProfile,
                createdAt: this.context.now(),
                title: attributionLabel,
                body: `${text}\n\nChoose a button or reply in this message's thread. Completion returns to the original conversation.`,
                actions: buttonActions,
              }),
              allowedActorIds: [origin.origin.event.actor.platformUserId],
              bindingId: sourceBinding?.id,
            }
          : {
              id: this.context.host().newIntentId("private-response"),
              kind: "message",
              bindingId: sourceBinding?.id,
              createdAt: this.context.now(),
              role: "assistant",
              attribution: {
                label: attributionLabel,
                hint: awaitReply
                  ? "Private Request · Reply in Thread to Respond to this Agent; Completion Returns to the Original Conversation"
                  : "Private Request · Reply in Thread to Respond to this Agent",
              },
              parts: [{ type: "text", text, markdown: "markdown" }],
            },
        undefined,
        privateEvent,
      );
      if (!isVisibleAssistantStreamDelivery(result)) {
        return {
          ok: false,
          error: {
            code: result.outcome === "unsupported"
              ? "unsupported_operation"
              : "internal_error",
            message:
              result.errorMessage
              ?? "The private response was not delivered, so the source response was not suppressed.",
          },
        };
      }

      this.context.privateResponses.delivered(privateReceipt);
      let sourceStreamsCancelled = true;
      let sourceWorkingUpdatesCancelled = true;
      if (sourceBinding) {
        this.context.toolUpdatePolicy.flush({
          bindingId: sourceBinding.id,
          clear: true,
          turnId: request.context.turnId,
        });
        this.context.host().clearTurnProse(sourceBinding.id, request.context.turnId);
        [sourceStreamsCancelled, sourceWorkingUpdatesCancelled] = await Promise.all([
          this.context.host().cancelAssistantStreamsForTurn(
            sourceBinding,
            request.context.turnId,
          ),
          this.context.host().cancelWorkingUpdatesForTurn(
            sourceBinding,
            request.context.turnId,
          ),
        ]);
      }
      if (!sourceStreamsCancelled || !sourceWorkingUpdatesCancelled) {
        return {
          ok: false,
          error: {
            code: "internal_error",
            message:
              "The private response was delivered, but existing source output could not be fully retracted. Further source output remains suppressed.",
          },
        };
      }
      if (sourceBinding) {
        await this.context.host().clearTerminalPrivateResponseActivity(
          sourceBinding,
          request.context.turnId,
        );
      }
      if (awaitReply && (!sourceBinding || !result.continuation)) {
        return {
          ok: false,
          error: {
            code: "unsupported_operation",
            message:
              "The private response was delivered, but this provider did not return a reply thread for the requested continuation. Further source output remains suppressed.",
          },
        };
      }
      if (sourceBinding && result.continuation) {
        try {
          let continuationBinding = await this.context.host().bindChannelToThread(
            {
              ...privateEvent,
              id: `${privateEvent.id}:continuation`,
              channel: result.continuation.channel,
              routingState: result.continuation.routingState,
            },
            {
              backend: request.context.backend,
              recordTransition: false,
              statusPresentation: "on_demand",
              threadId: request.context.threadId,
              targetKind: sourceBinding.targetKind ?? "agent_thread",
            },
          );
          if (awaitReply) {
            continuationBinding = await this.context.store.upsertBinding({
              ...continuationBinding,
              privateReplyContinuation: {
                createdAt: this.context.now(),
                expiresAt: this.context.now() + PRIVATE_REPLY_CONTINUATION_TTL_MS,
                instructions: replyInstructions,
                ...(requestId ? { requestId } : {}),
                ...(result.surface ? { requestSurface: result.surface } : {}),
                replyOptions: replyOptions.map((option) => ({
                  label: option.label.trim(),
                  text: option.text.trim(),
                })),
                source: privateReplySourceFromBinding(sourceBinding),
              },
              updatedAt: this.context.now(),
            });
            this.context.host().notifyBindingChanged("private-reply-awaiting");
          }
          await this.context.host().clearTerminalPrivateResponseActivity(
            continuationBinding,
            request.context.turnId,
          );
        } catch (error) {
          this.context.logger.warn?.("messaging private response continuation bind failed", {
            backend: request.context.backend,
            error: error instanceof Error ? error.message : String(error),
            threadId: request.context.threadId,
          });
          return {
            ok: false,
            error: {
              code: "internal_error",
              message:
                "The private response was delivered, but replies to it could not be routed back to this Agent. Further source output remains suppressed.",
            },
          };
        }
      }
      return {
        ok: true,
        data: {
          awaitingReply: awaitReply,
          channel: result.channel,
          deliveredAt: result.deliveredAt,
          outcome: "delivered",
          recipient: summarizeMessagingActor(origin.origin.event.actor),
        },
      };
    } finally {
      this.context.privateResponses.finishTool(privateReceipt);
    }
  }

  async sendMessagingFileFromAgentMessagingOrigin(
    request: Extract<
      PwrAgentMessagingRequest,
      { operation: "send_messaging_file" }
    >,
    receivedFile?: Uint8Array,
  ): Promise<PwrAgentMessagingResponse> {
    const invalid = validateMessagingFileMetadata(request.args);
    if (invalid) return { ok: false, error: { code: invalid.code, message: invalid.message } };
    if (request.context.requestingInstanceId && !receivedFile) {
      return { ok: false, error: { code: "forbidden", message: "Federated file sends require received bytes, never a provider-owner path." } };
    }
    const caption = typeof request.args?.caption === "string"
      ? request.args.caption.trim()
      : "";
    const filename = typeof request.args?.filename === "string"
      ? request.args.filename.trim()
      : "";
    const mediaKind = request.args?.mediaKind;
    if (
      mediaKind !== undefined
      && mediaKind !== "auto"
      && mediaKind !== "document"
      && mediaKind !== "image"
    ) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message:
            "send_messaging_file mediaKind must be document, image, or auto.",
        },
      };
    }
    if (caption.length > 4_000) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message:
            "send_messaging_file caption must be at most 4,000 characters.",
        },
      };
    }
    const permission = this.context.host().checkDynamicToolPermission({
      backend: request.context.backend,
      threadId: request.context.threadId,
      turnId: request.context.turnId,
      category: "messaging_context",
      tool: "send_messaging_file",
    });
    if (permission.owns && !permission.allowed) {
      return {
        ok: false,
        error: {
          code: "forbidden",
          message:
            `The messaging user who started this turn lacks permission for this tool (${
              permission.permission ?? "message.reply"
            }).`,
        },
      };
    }
    const sendPrivately = request.args?.private === true;
    if (sendPrivately && !request.context.turnId) {
      return {
        ok: false,
        error: {
          code: "not_found",
          message:
            "Private file delivery requires the active messaging turn that identified the requesting user.",
        },
      };
    }
    const origin = await this.resolveAgentMessagingOrigin(request.context);
    if (!origin.ok) {
      return origin;
    }

    // Resolve the destination before loading bytes. A file may run to the
    // provider's whole upload ceiling, and every failure below is knowable
    // without reading it.
    let deliveryEvent = origin.origin.event;
    if (sendPrivately) {
      if (!this.context.adapter.resolvePrivateConversation) {
        return {
          ok: false,
          error: {
            code: "unsupported_operation",
            message:
              "This messaging provider cannot send a private file to the requesting user.",
          },
        };
      }
      let privateConversation: MessagingPrivateConversationResolveResult;
      try {
        privateConversation = await this.context.adapter.resolvePrivateConversation({
          actor: origin.origin.event.actor,
          source: origin.origin.event.channel,
          routingState: origin.origin.event.routingState,
        });
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "internal_error",
            message:
              error instanceof Error
                ? `Could not resolve a private conversation: ${error.message}`
                : "Could not resolve a private conversation.",
          },
        };
      }
      if (
        privateConversation.outcome !== "resolved"
        || !privateConversation.conversation
        || privateConversation.channel !== origin.origin.event.channel.channel
      ) {
        return {
          ok: false,
          error: {
            code: privateConversation.outcome === "unsupported"
              ? "unsupported_operation"
              : "internal_error",
            message:
              privateConversation.errorMessage
              ?? "The messaging provider could not resolve a private conversation.",
          },
        };
      }
      deliveryEvent = {
        ...origin.origin.event,
        id: `${origin.origin.event.id}:private-file:${this.context.now()}`,
        channel: {
          channel: privateConversation.channel,
          conversation: privateConversation.conversation,
        },
        receivedAt: this.context.now(),
        routingState: privateConversation.routingState,
      };
    }

    const fileRequest = {
      path: typeof request.args?.path === "string" ? request.args.path : "",
      ...(filename ? { filename } : {}),
      ...(mediaKind ? { mediaKind } : {}),
    };
    const outbound = receivedFile
      ? resolveMessagingOutboundBytes(fileRequest, this.context.capabilityProfile.outboundAttachments ?? {}, receivedFile)
      : await resolveMessagingOutboundFile(fileRequest, this.context.capabilityProfile.outboundAttachments ?? {},
        await this.resolveOutboundFileAccess(request.context));
    if (!outbound.ok) {
      return {
        ok: false,
        error: {
          code: outbound.code,
          message: outbound.message,
        },
      };
    }

    if (request.context.requestingInstanceId) {
      const permission = await this.context.host().authorizeRetainedTool(request.context, {
        ...request.context, category: "messaging_context", tool: "send_messaging_file", arguments: request.args,
      });
      if (!permission.allowed || !(await this.resolveAgentMessagingOrigin(request.context)).ok) {
        return { ok: false, error: { code: "forbidden", message: "The original messaging authority changed before file delivery." } };
      }
    }
    const sourceBinding = origin.origin.deliveryBinding ?? origin.origin.binding;
    const filePart = outbound.mediaKind === "image"
      ? {
          type: "image" as const,
          // Bytes, not a base64 data URL. See MessagingImagePart.data — the
          // round trip through text costs several copies of the whole file.
          url: "",
          data: outbound.data,
          mimeType: outbound.mimeType,
          alt: outbound.filename,
          name: outbound.filename,
          sourceUrl: outbound.path,
        }
      : {
          type: "file" as const,
          name: outbound.filename,
          data: outbound.data,
          mimeType: outbound.mimeType,
          sizeBytes: outbound.sizeBytes,
        };
    const result = await this.context.host().deliver(
      {
        id: this.context.host().newIntentId("messaging-file"),
        kind: "message",
        bindingId: sourceBinding?.id,
        createdAt: this.context.now(),
        delivery: {
          requireAttachments: true,
        },
        role: "assistant",
        parts: [
          ...(caption
            ? [{ type: "text" as const, text: caption, markdown: "markdown" as const }]
            : []),
          filePart,
        ],
      },
      sendPrivately ? undefined : sourceBinding,
      deliveryEvent,
    );
    if (!isVisibleAssistantStreamDelivery(result)) {
      return {
        ok: false,
        error: {
          code: result.outcome === "unsupported"
            ? "unsupported_operation"
            : "internal_error",
          message:
            result.errorMessage
            ?? "The file was not delivered to the messaging surface.",
        },
      };
    }
    this.recordOutboundFileActivity({
      backend: request.context.backend,
      binding: sourceBinding,
      event: deliveryEvent,
      file: {
        filename: outbound.filename,
        mediaKind: outbound.mediaKind,
        mimeType: outbound.mimeType,
        path: outbound.path,
        sizeBytes: outbound.sizeBytes,
      },
      deliveredAt: result.deliveredAt,
      private: sendPrivately,
      threadId: request.context.threadId,
    });
    if (
      !sendPrivately
      && sourceBinding
      && filePart.type === "image"
    ) {
      this.rememberOutboundMessagingFileImages({
        backend: request.context.backend,
        binding: sourceBinding,
        images: [filePart],
        pathAliases: [outbound.path, typeof request.args?.path === "string"
          ? request.args.path.trim()
          : ""],
        threadId: request.context.threadId,
        turnId: request.context.turnId,
      });
    }

    return {
      ok: true,
      data: {
        channel: deliveryEvent.channel.channel,
        conversation: summarizeMessagingConversation(
          deliveryEvent.channel.conversation,
        ),
        deliveredAt: result.deliveredAt,
        filename: outbound.filename,
        mediaKind: outbound.mediaKind,
        mimeType: outbound.mimeType,
        outcome: "delivered",
        private: sendPrivately,
        sizeBytes: outbound.sizeBytes,
        ...(sendPrivately
          ? { recipient: summarizeMessagingActor(origin.origin.event.actor) }
          : {}),
      },
    };
  }

  rememberOutboundMessagingFileImages(params: {
    backend: AppServerBackendKind;
    binding: MessagingBindingRecord;
    images: MessagingImagePart[];
    pathAliases?: readonly string[];
    threadId: ThreadIdentifier;
    turnId?: string;
  }): void {
    if (params.images.length === 0) {
      return;
    }
    const identity = {
      threadId: params.threadId,
      turnId: params.turnId,
    };
    const syntheticEvent = {
      backend: params.backend,
      notification: {
        method: "item/completed",
        params: {
          threadId: params.threadId,
          turnId: params.turnId,
        },
      },
    } as AgentEvent;
    const variants: MessagingImagePart[][] = [params.images];
    for (const image of params.images) {
      // Only claim the sourceUrl-less shape when `url` still identifies the
      // image. A bytes-backed part has an empty url, and claiming that would
      // register a signature matching any other empty-url image.
      if (image.url) {
        variants.push([{ ...image, sourceUrl: undefined }]);
      }
      const aliases = outboundImageClaimAliases([
        image.sourceUrl,
        image.url,
        ...(params.pathAliases ?? []),
      ]);
      for (const alias of aliases) {
        variants.push([{
          ...image,
          url: alias,
          sourceUrl: alias,
        }]);
      }
    }
    for (const images of variants) {
      this.context.host().claimAssistantMessageContentDelivery(
        syntheticEvent,
        params.binding,
        assistantImageDeliverySignature(images),
        identity,
      );
    }
  }

  async resolveOutboundFileAccess(
    context: PwrAgentMessagingRequest["context"],
  ): Promise<MessagingOutboundFileAccess> {
    const configured = this.context.config.outboundFileAccess?.();
    const allowedRoots = [
      ...resolveScratchProjectsRoots(),
      ...(configured?.allowedRoots ?? []),
    ];
    try {
      const thread = await this.context.host().readExactNavigationThread({ ref: { backend: context.backend, threadId: context.threadId } });
      if (thread?.projectKey) {
        allowedRoots.push(thread.projectKey);
      }
      for (const directory of thread?.linkedDirectories ?? []) {
        allowedRoots.push(directory.path);
        if (directory.worktreePath) {
          allowedRoots.push(directory.worktreePath);
        }
      }
    } catch {
      // Scratch-project and configured roots still apply.
    }
    return {
      allowedRoots,
      ...(configured?.privateStorageRoots
        ? { privateStorageRoots: configured.privateStorageRoots }
        : {}),
    };
  }

  async handleOriginalAttachmentRequest(
    request: Extract<PwrAgentMessagingRequest, { operation: "list_messaging_attachments" | "export_messaging_attachment" }>,
    consumeOriginal?: OriginalAttachmentConsumer,
  ): Promise<PwrAgentMessagingResponse> {
    const store = this.context.config.originalAttachmentStore;
    if (!store) return { ok: false, error: { code: "not_found", message: "No original-file cache is available on this messaging owner. Ask the sender to reattach the file after upgrading." } };
    if (request.context.causalMessagingAmbiguous) return this.retainedSourceUnavailable(request.context);
    const active = request.context.turnId ? this.context.host().activeAgentMessagingOriginsByTurnKey.get(
      agentMessagingTurnKey(request.context.backend, request.context.threadId, request.context.turnId),
    ) : undefined;
    const source = this.context.host().retainedRequestSource(request.context);
    const event = source?.event ?? active?.event;
    // The request store is shared by every provider. An unrelated controller
    // must yield before actor authorization, so the owner can decide access.
    if (event && !this.context.host().isChannelInScope(event.channel)) {
      return { ok: false, error: { code: "not_found", message: "No original attachments for this messaging provider." } };
    }
    const remote = request.context.requestingInstanceId;
    // The authenticated caller must be the actual execution owner, including
    // full peers. A source ref or colliding thread ID alone is never a grant.
    const remoteAuthorized = async (verifyAccess = true): Promise<boolean> => {
      if (!remote || !source || !source.bindingId || source.agent.backend !== request.context.backend
        || source.agent.threadId !== request.context.threadId) return false;
      if (!await this.context.host().retainedSourceIsAuthorized(source, verifyAccess)) return false;
      const binding = await this.context.store.findActiveBindingForChannel(source.event.channel);
      return binding?.id === source.bindingId && binding.backend === request.context.backend
        && binding.threadId === request.context.threadId && containedMessagingBindingMatches(request.context, binding)
        && this.context.host().retainedRequestCanCrossInstance(request.context, source)
        && this.context.host().checkDynamicToolPermission({ ...request.context, category: "messaging_context",
          tool: request.operation, arguments: request.args }, source).allowed;
    };
    if (remote && !await remoteAuthorized()) return this.retainedSourceUnavailable(request.context);
    if (!event && (request.context.messagingTurn || request.context.causalMessagingSource)) {
      return { ok: false, error: { code: "not_found", message:
        "This messaging turn's actor cannot be reauthorized after restart. Send a new message in the original conversation, or request the save in a local desktop turn on this thread." } };
    }
    if (!remote && !active && request.context.causalMessagingSource && (!source || !await this.context.host().retainedSourceIsAuthorized(source))) {
      return this.retainedSourceUnavailable(request.context);
    }
    const permission = this.context.host().checkDynamicToolPermission({ ...request.context,
      category: "messaging_context", tool: request.operation, arguments: request.args,
    }, source);
    if (!permission.allowed) return { ok: false, error: { code: "forbidden", message: "The requesting actor cannot access received attachments." } };
    const scope = { backend: request.context.backend, threadId: request.context.threadId, provider: this.context.config.channel,
      ...(remote ? { instanceId: remote } : {}) };
    const actorKey = event ? originalAttachmentActorKey(event) : undefined;
    try {
      if (request.operation === "list_messaging_attachments") {
        if (request.args.cursor !== undefined && typeof request.args.cursor !== "string") {
          return { ok: false, error: { code: "invalid_arguments", message: "cursor must be a returned nextCursor string." } };
        }
        const result = await store.list(scope, actorKey, request.args.cursor);
        return result.attachments.length > 0 ? { ok: true, data: result } : {
          ok: false, error: { code: "not_found", message: "No retained originals in this thread/page. Files expire after 7 days or earlier at the cache limit. Old previews do not restore bytes; ask the sender to reattach missing or oversized files (10 MiB maximum)." },
        };
      }
      if (typeof request.args.attachmentId !== "string" || !/^[a-f0-9]{64}$/u.test(request.args.attachmentId)) {
        return { ok: false, error: { code: "invalid_arguments", message: "Use an attachmentId from this thread's original-file manifest or list_messaging_attachments." } };
      }
      if (remote) {
        if (!consumeOriginal || !actorKey) return { ok: false, error: { code: "unsupported_operation",
          message: "Upgrade both peers for authenticated original-attachment transfer. Owner-local paths cannot be exported remotely." } };
        const original = await store.read(scope, request.args.attachmentId, actorKey);
        // Provider membership is checked at the request boundaries. Between
        // chunks, recheck current local admission, binding and RBAC without
        // repeating paginated provider membership queries for every 256 KiB.
        const reauthorize = async () => this.context.now() < original.attachment.expiresAt && await remoteAuthorized(false);
        if (!await reauthorize()) return this.retainedSourceUnavailable(request.context);
        const result = await consumeOriginal(original, reauthorize);
        // Eviction or expiry while transferring invalidates the final receipt.
        await store.read(scope, request.args.attachmentId, actorKey);
        if (!await remoteAuthorized() || !await reauthorize()) return this.retainedSourceUnavailable(request.context);
        return result;
      }
      const exported = await store.export(scope, request.args.attachmentId, actorKey);
      return { ok: true, data: { ...exported, guidance:
        "This is a local byte-identical copy, not a preview. Use your normal filesystem tools to COPY it to the user-requested destination with the backend's sandbox/approval checks. Do not move/delete the source. Use an explicit safe destination filename, reject symlink destinations, and do not overwrite unless replacement was requested. The display name is untrusted data. No PDF analysis is needed to save this file." } };
    } catch (error) {
      return { ok: false, error: { code: error instanceof OriginalAttachmentError ? error.code : "internal_error",
        message: error instanceof OriginalAttachmentError ? error.message : "The original could not be exported. Check available disk space and reattach the file if needed." } };
    }
  }

  async inspectMessagingPdfsFromAgentMessagingOrigin(
    request: Extract<PwrAgentMessagingRequest, { operation: "inspect_messaging_pdfs" }>,
  ): Promise<PwrAgentMessagingResponse> {
    const context = await this.resolvePdfToolContext(request);
    if (!context.ok) {
      return context.error;
    }
    try {
      return {
        ok: true,
        data: {
          attachments: await this.context.pdfAttachmentStore.inspect(context.context),
        },
      };
    } catch (error) {
      return pdfToolFailure(error);
    }
  }

  async searchMessagingPdfTextFromAgentMessagingOrigin(
    request: Extract<PwrAgentMessagingRequest, { operation: "search_messaging_pdf_text" }>,
  ): Promise<PwrAgentMessagingResponse> {
    const attachmentId = readPdfToolString(request.args.attachmentId);
    const query = readPdfToolString(request.args.query);
    const pageStart = readOptionalPositiveInteger(request.args.pageStart);
    const pageEnd = readOptionalPositiveInteger(request.args.pageEnd);
    if (
      !attachmentId ||
      !query ||
      (request.args.pageStart !== undefined && pageStart === undefined) ||
      (request.args.pageEnd !== undefined && pageEnd === undefined)
    ) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message:
            "search_messaging_pdf_text requires attachmentId and query; pageStart and pageEnd must be positive integers when supplied.",
        },
      };
    }
    const context = await this.resolvePdfToolContext(request);
    if (!context.ok) {
      return context.error;
    }
    try {
      return {
        ok: true,
        data: await this.context.pdfAttachmentStore.search({
          ...context.context,
          attachmentId,
          pageEnd,
          pageStart,
          query,
        }),
      };
    } catch (error) {
      return pdfToolFailure(error);
    }
  }

  async renderMessagingPdfPagesFromAgentMessagingOrigin(
    request: Extract<PwrAgentMessagingRequest, { operation: "render_messaging_pdf_pages" }>,
  ): Promise<PwrAgentMessagingResponse> {
    if (request.context.backend !== "codex") {
      return {
        ok: false,
        error: {
          code: "unsupported_operation",
          message:
            "Rendered messaging PDF pages are currently available only to Codex PDF analysis turns.",
        },
      };
    }
    const attachmentId = readPdfToolString(request.args.attachmentId);
    const pageNumbers = readPdfToolPageNumbers(request.args.pageNumbers);
    if (!attachmentId || !pageNumbers) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message:
            "render_messaging_pdf_pages requires attachmentId and one or more positive integer pageNumbers.",
        },
      };
    }
    const context = await this.resolvePdfToolContext(request);
    if (!context.ok) {
      return context.error;
    }
    try {
      const rendered = await this.context.pdfAttachmentStore.render({
        ...context.context,
        attachmentId,
        pageNumbers,
      });
      return {
        ok: true,
        data: rendered.result,
        imageContent: rendered.imageContent,
      };
    } catch (error) {
      return pdfToolFailure(error);
    }
  }

  async resolvePdfToolContext(
    request: PwrAgentMessagingRequest,
  ): Promise<
    | {
        ok: true;
        context: {
          backend: AppServerBackendKind;
          threadId: ThreadIdentifier;
          turnId: string;
        };
      }
    | { ok: false; error: Extract<PwrAgentMessagingResponse, { ok: false }> }
  > {
    if (!request.context.turnId) {
      return {
        ok: false,
        error: {
          ok: false,
          error: {
            code: "not_found",
            message: "Messaging PDF tools require an active messaging turn.",
          },
        },
      };
    }
    if (request.context.requestingInstanceId && !this.context.pdfAttachmentStore.authorizesSource({
      backend: request.context.backend, threadId: request.context.threadId, turnId: request.context.turnId,
    }, request.context.requestingInstanceId, request.context.causalMessagingSource)) {
      return { ok: false, error: { ok: false, error: { code: "forbidden", message: "PDF attachments do not belong to this source and messaging turn." } } };
    }
    const origin = await this.resolveAgentMessagingOrigin(request.context);
    if (!origin.ok) {
      return { ok: false, error: origin };
    }
    return {
      ok: true,
      context: {
        backend: request.context.backend,
        threadId: request.context.threadId,
        turnId: request.context.turnId,
      },
    };
  }

  async resolveAttachTarget(request: {
    backend: AppServerBackendKind;
    threadId: string;
    instanceId?: string;
    includeRemote: boolean;
  }): Promise<AttachTargetResolution> {
    let target: NavigationThreadSummary | undefined;
    try {
      if (this.context.backend.resolveThreadTarget) {
        const resolved = await this.context.backend.resolveThreadTarget(request);
        return resolved
          ? { ok: true, ...resolved }
          : attachTargetNotFound(request.backend, request.threadId);
      }
      if (request.instanceId || request.includeRemote === false) {
        return attachTargetNotFound(request.backend, request.threadId);
      }
      target = await this.context.host().readExactNavigationThread({ ref: { backend: request.backend, threadId: request.threadId } });
    } catch (error) {
      return {
        ok: false,
        error: {
          code:
            error instanceof MessagingFederatedThreadTargetError
              ? error.code
              : "internal_error",
          message:
            error instanceof Error
              ? `Could not verify target thread before attaching: ${error.message}`
              : "Could not verify target thread before attaching.",
        },
      };
    }

    if (!target) {
      return attachTargetNotFound(request.backend, request.threadId);
    }

    return { ok: true, thread: target };
  }

  resolveAttachPlacement(params: {
    location: PwrAgentMessagingLocationSummary;
    origin: ActiveAgentMessagingOrigin;
    placement: "auto" | "current_conversation" | "new_child";
  }):
    | { ok: true; placement: "current_conversation" | "new_child" }
    | Extract<PwrAgentMessagingResponse, { ok: false }> {
    if (params.placement !== "auto") {
      if (
        params.placement === "new_child" &&
        !params.location.managedConversation.canCreateChild
      ) {
        return {
          ok: false,
          error: {
            code: "unsupported_operation",
            message: managedConversationUnavailableMessage(
              params.location.managedConversation,
            ),
          },
        };
      }
      return { ok: true, placement: params.placement };
    }

    if (params.location.managedConversation.canCreateChild) {
      return { ok: true, placement: "new_child" };
    }

    const sourceConversationKind = params.origin.event.channel.conversation.kind;
    const canAttachToCurrentUnboundConversation =
      !params.origin.binding
      && (
        sourceConversationKind === "dm"
        || sourceConversationKind === "thread"
        || sourceConversationKind === "topic"
      );
    const canReplaceCurrentThreadOrTopicBinding =
      Boolean(params.origin.binding)
      && params.origin.binding?.targetKind !== "agent_thread"
      && (
        sourceConversationKind === "thread"
        || sourceConversationKind === "topic"
      );
    if (
      canAttachToCurrentUnboundConversation
      || canReplaceCurrentThreadOrTopicBinding
    ) {
      return { ok: true, placement: "current_conversation" };
    }

    return {
      ok: false,
      error: {
        code: "unsupported_operation",
        message:
          `${managedConversationUnavailableMessage(
            params.location.managedConversation,
          )} Pass placement=current_conversation only if replacing the current conversation binding is intended.`,
      },
    };
  }

  async resolveAgentMessagingOrigin(
    context: PwrAgentMessagingRequest["context"],
  ): Promise<AgentMessagingOriginResolution> {
    if (context.requestingInstanceId && context.causalMessagingSource) {
      const source = this.context.host().retainedRequestSource(context);
      if (!source || !this.context.host().isChannelInScope(source.event.channel)) return this.retainedSourceUnavailable(context, "not_found");
      if (!this.context.host().retainedRequestCanCrossInstance(context, source) || !this.context.host().retainedSourceHasPermissions(source)
        || !await this.context.host().retainedSourceIsAuthorized(source)) return this.retainedSourceUnavailable(context);
      return { ok: true, origin: await this.originForRetainedSource(source) };
    }
    if (context.turnId) {
      const origin = this.context.host().activeAgentMessagingOriginsByTurnKey.get(
        agentMessagingTurnKey(context.backend, context.threadId, context.turnId),
      );
      if (
        !origin
        || !this.context.host().isChannelInScope(origin.binding?.channel ?? origin.event.channel)
      ) {
        return {
          ok: false,
          error: {
            code: "not_found",
            message:
              "No active messaging origin is recorded for this Agent turn. For a delegated/completion request, use list_messaging_surfaces and attach_thread_to_surface to inspect and select its retained destination.",
          },
        };
      }
      return { ok: true, origin };
    }

    let navigation: MessagingThreadContext | undefined;
    try {
      navigation = { kind: "thread", thread: await this.context.host().readExactNavigationThread({
        ref: { backend: context.backend, threadId: context.threadId },
      }) };
    } catch {
      navigation = undefined;
    }

    const bindings = this.context.host().filterBindingsForChannel(
      await this.context.store.findActiveBindingsForThread({
        backend: context.backend,
        threadId: context.threadId,
      }),
    ).filter((binding) =>
      isMessagingToolOriginBinding(binding, navigation)
    );
    if (bindings.length === 0) {
      return {
        ok: false,
        error: {
          code: "not_found",
          message:
            "No active messaging binding is attached to this Agent or handoff thread.",
        },
      };
    }
    if (bindings.length > 1) {
      return {
        ok: false,
        error: {
          code: "ambiguous_location",
          message:
            "This Agent or handoff thread is attached to more than one messaging surface; call from an active messaging turn so PwrAgent can resolve here.",
        },
      };
    }
    const binding = bindings[0]!;
    return {
      ok: true,
      origin: {
        binding,
        event: eventFromBinding(binding, this.context.now()),
      },
    };
  }

  async summarizeAgentMessagingLocation(
    origin: ActiveAgentMessagingOrigin,
    options: { navigation?: MessagingNavigationContext } = {},
  ): Promise<PwrAgentMessagingLocationSummary> {
    return {
      actor: summarizeMessagingActor(origin.event.actor),
      ...(origin.binding
        ? {
            binding: summarizeMessagingBinding(
              origin.binding,
              await this.context.host().resolveBoundThreadSummary(
                origin.binding,
                options.navigation,
              ),
            ),
          }
        : {}),
      channel: origin.event.channel.channel,
      conversation: summarizeMessagingConversation(origin.event.channel.conversation),
      conversationCapabilities: this.summarizeConversationCapabilities(origin),
      managedConversation: await this.resolveManagedConversationSummary(origin),
      outboundAttachments: this.summarizeOutboundAttachments(),
    };
  }

  summarizeConversationCapabilities(
    origin: ActiveAgentMessagingOrigin,
  ): PwrAgentMessagingConversationCapabilitiesSummary {
    const permissions = this.context.host().resolveActorPermissions(origin.event);
    return {
      rename: {
        allowed:
          permissions === null
          || permissions.permissions.has("thread.settings.name"),
        supported: this.context.adapter.supportsConversationTitle?.({
          actor: origin.event.actor,
          channel: origin.event.channel,
          routingState: origin.event.routingState ?? origin.binding?.routingState,
        }) === true,
      },
    };
  }

  summarizeOutboundAttachments(): PwrAgentMessagingOutboundAttachmentSummary {
    const profile = this.context.capabilityProfile.outboundAttachments;
    return {
      ...(profile?.maxUploadBytes !== undefined
        ? { maxUploadBytes: profile.maxUploadBytes }
        : {}),
      supportsFileUpload: profile?.supportsFileUpload === true,
      supportsImageUpload: profile?.supportsImageUpload === true,
    };
  }

  async resolveManagedConversationSummary(
    origin: ActiveAgentMessagingOrigin,
  ): Promise<PwrAgentMessagingManagedConversationSummary> {
    const providerSupportsCreation =
      typeof this.context.adapter.createManagedConversation === "function";
    if (!this.context.adapter.getManagedConversationRights) {
      const operation = {
        operation: "create_child" as const,
        supported: providerSupportsCreation,
        reason: providerSupportsCreation
          ? "provider does not expose permission preflight"
          : "provider does not support managed conversations",
      };
      return {
        canCreateChild: providerSupportsCreation,
        operation,
        operations: [operation],
        outcome: providerSupportsCreation ? "ok" : "unsupported",
        providerSupportsCreation,
      };
    }

    const rights = await this.context.adapter.getManagedConversationRights({
      actor: origin.event.actor,
      channel: origin.event.channel,
      routingState: origin.event.routingState,
      sourceSurface: origin.event.sourceSurface,
    });
    const operation = rights.operations.find(
      (candidate) => candidate.operation === "create_child",
    );
    return {
      canCreateChild: providerSupportsCreation && operation?.supported === true,
      operation,
      operations: rights.operations.map((candidate) => ({ ...candidate })),
      outcome: rights.outcome,
      errorMessage: rights.errorMessage,
      providerSupportsCreation,
      updatedAt: rights.updatedAt,
    };
  }

  recordOutboundFileActivity(params: {
    backend: AppServerBackendKind;
    binding: MessagingBindingRecord | undefined;
    event: MessagingInboundEvent;
    file: {
      filename: string;
      mediaKind: "document" | "image";
      mimeType: string;
      path: string;
      sizeBytes: number;
    };
    deliveredAt: number;
    private: boolean;
    threadId: ThreadIdentifier;
  }): void {
    try {
      const log = this.context.host().desktopActivityLog();
      if (!log) return;
      const conversation = params.event.channel.conversation;
      log.record({
        platform: params.event.channel.channel,
        kind: "outbound",
        backend: params.backend,
        threadId: params.threadId,
        bindingId: params.binding?.id,
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        actorId: params.event.actor.platformUserId,
        actorDisplayName: params.event.actor.displayName,
        summary: `Sent ${params.file.filename}${
          params.private ? " privately" : ""
        } (${params.file.sizeBytes} bytes)`,
        createdAt: params.deliveredAt,
        payload: {
          tool: "send_messaging_file",
          filename: params.file.filename,
          mediaKind: params.file.mediaKind,
          mimeType: params.file.mimeType,
          sizeBytes: params.file.sizeBytes,
          sourcePath: params.file.path,
          private: params.private,
          conversationKind: conversation.kind,
        },
      });
    } catch {
      // Activity log is best-effort observability.
    }
  }
}
