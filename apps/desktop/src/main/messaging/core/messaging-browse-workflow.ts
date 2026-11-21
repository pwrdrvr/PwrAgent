import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import type { NavigationQuery } from "@pwragent/shared/contracts/navigation";
import type {
  MessagingBindingRecord,
  MessagingBrowseSessionRecord,
  MessagingCapabilityProfile,
  MessagingChannelRef,
  MessagingDeliveryResult,
  MessagingInboundCommandEvent,
  MessagingInboundEvent,
  MessagingPendingIntentRecord,
  MessagingSurfaceIntent,
  MessagingSurfaceRef,
} from "@pwragent/messaging-interface";
import type { MessagingAccessControl } from "./messaging-access-control";
import type { MessagingBackendBridge } from "./messaging-adapter";
import type { MessagingControllerLogger, MessagingDeliveryGuard } from "./messaging-backend-event-helpers";
import { MessagingBrowseQueryPool } from "./messaging-browse-query-pool";
import { defaultAgentBackendSupport, defaultAgentScopeForChannel, type MessagingDefaultAgentScopeKind } from "./messaging-default-agent";
import { readMessagingLaunchpadContext, type MessagingLaunchpadContext, type MessagingNewThreadNavigation } from "./messaging-launchpad-context";
import type { MessagingNewThreadWorkflow } from "./messaging-new-thread-workflow";
import { buildErrorIntent } from "./messaging-renderer";
import { buildBoundedResumeIntent, isNewThreadLaunchAction, parseResumeCommandArgs, resumeBrowserPageSize } from "./messaging-resume-browser";
import type { MessagingStoreLike } from "./messaging-storage";
import { buildMessagingConversationKey } from "./messaging-store";

interface MessagingBrowseContext {
  readonly backend: Pick<MessagingBackendBridge,
    "getNavigationQueryPage" | "getNavigationLaunchpadConfig" | "ensureDirectoryLaunchpad" | "listNavigationOwners">;
  readonly store: Pick<MessagingStoreLike,
    "upsertBrowseSession" | "upsertPendingIntent" | "deleteBrowseSession" | "deletePendingIntentsForChannel">;
  readonly capabilityProfile: MessagingCapabilityProfile;
  readonly now: () => number;
  readonly pendingIntentTtlMs: number;
  readonly disposed: boolean;
  readonly logger: MessagingControllerLogger;
  readonly deliver: (intent: MessagingSurfaceIntent, binding?: MessagingBindingRecord, event?: MessagingInboundEvent, guard?: MessagingDeliveryGuard) => Promise<MessagingDeliveryResult>;
  readonly storePendingIntent: (intent: MessagingSurfaceIntent, binding?: MessagingBindingRecord, event?: MessagingInboundEvent, options?: { expiresAt?: number }) => Promise<MessagingPendingIntentRecord>;
  readonly newIntentId: (prefix: string) => string;
  readonly resolveNewThreadBackendForSession: MessagingNewThreadWorkflow["resolveNewThreadBackendForSession"];
  readonly loadDefaultAgentBackendSummaries: () => Promise<BackendSummary[] | undefined>;
  readonly actorHasPermission: MessagingAccessControl["actorHasPermission"];
  readonly canResumeFullAccessThreads: MessagingAccessControl["canResumeFullAccessThreads"];
  readonly deliverDefaultAgentCommandError: (event: MessagingInboundEvent, body: string) => Promise<void>;
  readonly clearPendingNewThreadPrompt: (sessionId: string) => void;
  readonly clearPendingFullAccessNewThreadPrompt: (sessionId: string) => void;
}

export class MessagingBrowseWorkflow {
  private readonly browseRenderGenerations = new Map<string, symbol>();
  readonly queryPool = new MessagingBrowseQueryPool((request) => {
    const backend = this.context.backend;
    if (!backend.getNavigationQueryPage) throw new Error("Upgrade this instance to support bounded messaging navigation.");
    return backend.getNavigationQueryPage(request);
  }, () => this.context.now());
  private readonly progressiveBrowseByConversation = new Map<string, symbol>();

  constructor(private readonly context: MessagingBrowseContext) {}

  cancelProgressiveBrowse(channel: MessagingChannelRef): void {
    this.progressiveBrowseByConversation.delete(buildMessagingConversationKey(channel));
  }

  dispose(): void {
    this.progressiveBrowseByConversation.clear();
    this.queryPool.clear();
    this.browseRenderGenerations.clear();
  }

  async presentResumeBrowser(
    event: MessagingInboundCommandEvent,
    options?: {
      cancelDestination?: MessagingBrowseSessionRecord["cancelDestination"];
      targetSurface?: MessagingSurfaceRef;
    },
  ): Promise<void> {
    const parsed = parseResumeCommandArgs(event.args);
    if (parsed.error) {
      await this.context.deliver(
        buildErrorIntent({
          id: this.context.newIntentId("resume-error"),
          createdAt: this.context.now(),
          title: "Resume command error",
          body: parsed.error,
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    await this.presentProgressiveBrowse(event, {
      backend: "all",
      filter: parsed.query,
    }, async (navigation, current) => {
      const selectedBackend =
        isNewThreadLaunchAction(parsed.launchAction)
          ? await this.context.resolveNewThreadBackendForSession(
              {
                launchpadBackend: navigation.launchpadDefaults.backend,
              },
              event,
            )
          : undefined;
      if (isNewThreadLaunchAction(parsed.launchAction) && !selectedBackend) {
        return;
      }
      const selectedDirectory = navigation.directory;
      const preferences = parsed.preferences
        ? {
            ...parsed.preferences,
            updatedAt: this.context.now(),
          }
        : undefined;
      const session: MessagingBrowseSessionRecord = {
        id: this.context.newIntentId("browse"),
        allowedActorIds: [event.actor.platformUserId],
        backend: selectedBackend?.kind,
        cancelDestination: options?.cancelDestination,
        channel: event.channel,
        createdAt: this.context.now(),
        updatedAt: this.context.now(),
        expiresAt: this.context.now() + this.context.pendingIntentTtlMs,
        launchAction: parsed.launchAction,
        mode: parsed.cwd && parsed.mode === "recents" ? "project_threads" : parsed.mode,
        pageIndex: 0,
        pageSize: resumeBrowserPageSize(this.context.capabilityProfile),
        preferences,
        query: parsed.query,
        directorySelector: parsed.cwd,
        returnTo: parsed.launchAction === "start_new_thread"
          ? {
              launchAction: "resume_thread",
              mode: "recents",
              pageIndex: 0,
              preferences,
              query: parsed.query,
        directorySelector: parsed.cwd,
            }
          : undefined,
        selectedProject: selectedDirectory
          ? {
              directoryKey: selectedDirectory.key,
              label: selectedDirectory.label,
              path: selectedDirectory.path,
            }
          : undefined,
        surface: options?.targetSurface,
      };
      await this.renderResumeBrowser(session, navigation, event, current);
      return session;
    }, parsed.cwd);
  }

  async presentAgentBrowser(
    event: MessagingInboundCommandEvent,
    options?: {
      cancelDestination?: MessagingBrowseSessionRecord["cancelDestination"];
      targetSurface?: MessagingSurfaceRef;
    },
  ): Promise<void> {
    const parsed = parseResumeCommandArgs(event.args);
    if (parsed.error) {
      await this.context.deliver(
        buildErrorIntent({
          id: this.context.newIntentId("agent-error"),
          createdAt: this.context.now(),
          title: "Agent command error",
          body: parsed.error,
          recoverable: true,
        }),
        undefined,
        event,
      );
      return;
    }

    await this.presentProgressiveBrowse(event, {
      backend: "all",
      filter: parsed.query,
    }, async (navigation, current) => {
      const selectedBackend =
        parsed.launchAction === "start_new_thread"
          ? await this.context.resolveNewThreadBackendForSession(
              {
                launchpadBackend: navigation.launchpadDefaults.backend,
              },
              event,
            )
          : undefined;
      if (parsed.launchAction === "start_new_thread" && !selectedBackend) {
        return;
      }
      const selectedDirectory = navigation.directory;
      const session: MessagingBrowseSessionRecord = {
        id: this.context.newIntentId("browse"),
        allowedActorIds: [event.actor.platformUserId],
        backend: selectedBackend?.kind,
        cancelDestination: options?.cancelDestination,
        channel: event.channel,
        createdAt: this.context.now(),
        updatedAt: this.context.now(),
        expiresAt: this.context.now() + this.context.pendingIntentTtlMs,
        launchAction: parsed.launchAction === "start_new_thread"
          ? "start_new_agent_thread"
          : "resume_thread",
        mode: parsed.launchAction === "start_new_thread" ? "new_project" : "agents",
        pageIndex: 0,
        pageSize: resumeBrowserPageSize(this.context.capabilityProfile),
        preferences: parsed.preferences
          ? {
              ...parsed.preferences,
              updatedAt: this.context.now(),
            }
          : undefined,
        query: parsed.query,
        directorySelector: parsed.cwd,
        selectedProject: selectedDirectory
          ? {
              directoryKey: selectedDirectory.key,
              label: selectedDirectory.label,
              path: selectedDirectory.path,
            }
          : undefined,
        surface: options?.targetSurface,
      };
      await this.renderResumeBrowser(session, navigation, event, current);
      return session;
    }, parsed.cwd);
  }

  private async presentProgressiveBrowse(
    event: MessagingInboundEvent,
    _request: { backend?: "all"; filter?: string },
    initial: (navigation: MessagingLaunchpadContext, current: () => boolean) => Promise<MessagingBrowseSessionRecord | undefined>,
    _requestedDirectory?: string,
  ): Promise<void> {
    const key = buildMessagingConversationKey(event.channel);
    const generation = Symbol("browse");
    this.progressiveBrowseByConversation.set(key, generation);
    const current = (): boolean => !this.context.disposed && this.progressiveBrowseByConversation.get(key) === generation;
    try {
      const configuration = await readMessagingLaunchpadContext({ backend: this.context.backend });
      if (current()) await initial(configuration, current);
    } finally {
      if (current()) this.progressiveBrowseByConversation.delete(key);
    }
  }

  async presentDefaultAgentAssignmentBrowser(
    event: MessagingInboundEvent,
    scopeKind: MessagingDefaultAgentScopeKind,
  ): Promise<void> {
    const scope = defaultAgentScopeForChannel(event.channel, scopeKind);
    if (!scope) {
      await this.context.deliverDefaultAgentCommandError(
        event,
        `This messaging surface does not expose a normalized ${scopeKind} scope.`,
      );
      return;
    }
    const navigation = await readMessagingLaunchpadContext({ backend: this.context.backend });
    const session: MessagingBrowseSessionRecord = {
      id: this.context.newIntentId("default-agent-browse"),
      allowedActorIds: [event.actor.platformUserId],
      channel: event.channel,
      createdAt: this.context.now(),
      updatedAt: this.context.now(),
      expiresAt: this.context.now() + this.context.pendingIntentTtlMs,
      launchAction: "assign_default_agent",
      defaultAgentScope: scope,
      mode: "agents",
      pageIndex: 0,
      pageSize: resumeBrowserPageSize(this.context.capabilityProfile),
    };
    await this.renderResumeBrowser(session, navigation, event);
  }

  async retireBrowseSession(
    session: MessagingBrowseSessionRecord,
  ): Promise<void> {
    this.queryPool.release(session.id);
    this.context.clearPendingNewThreadPrompt(session.id);
    this.context.clearPendingFullAccessNewThreadPrompt(session.id);
    await this.context.store.deleteBrowseSession(session.id);
    try {
      const removed = await this.context.store.deletePendingIntentsForChannel({
        channel: session.channel,
      });
      if (removed.length > 0) {
        this.context.logger.debug?.("messaging retired channel pending intents on browse close", {
          channel: session.channel.channel,
          removedCount: removed.length,
          sessionId: session.id,
        });
      }
    } catch (error) {
      this.context.logger.debug?.("messaging pending-intent cleanup failed on browse close", {
        channel: session.channel.channel,
        error: error instanceof Error ? error.message : String(error),
        sessionId: session.id,
      });
    }
  }

  async renderResumeBrowser(
    session: MessagingBrowseSessionRecord,
    _navigation: MessagingNewThreadNavigation,
    event: MessagingInboundEvent,
    stillCurrent: () => boolean = () => true,
  ): Promise<void> {
    if (!stillCurrent()) return;
    const parentCurrent = stillCurrent;
    const token = Symbol("browse-render");
    this.browseRenderGenerations.set(session.id, token);
    stillCurrent = () => parentCurrent() && this.browseRenderGenerations.get(session.id) === token;
    const inventory = await this.context.backend.listNavigationOwners?.() ?? { owners: [{ label: "This instance" }], omitted: 0 };
    const canReadRemote = this.context.actorHasPermission(event, "federation.remote_control");
    let owners = inventory.owners.filter((owner) => !owner.target || (canReadRemote && session.launchAction !== "assign_default_agent"));
    if (!session.directorySelector && session.selectedProject && session.mode !== "projects" && session.mode !== "new_project") {
      const target = session.selectedProject.federationTarget;
      owners = target?.scope === "remote"
        ? (canReadRemote ? [{ target, label: inventory.owners.find((owner) => owner.target?.instanceId === target.instanceId)?.label ?? target.instanceId }] : [])
        : owners.filter((owner) => !owner.target);
    }
    const backendSummaries = session.launchAction === "assign_default_agent" ? await this.context.loadDefaultAgentBackendSummaries() : undefined;
    const eligibility = {
      filter: session.query,
      agentOnly: session.mode === "agents" || session.launchAction === "assign_default_agent",
      ...(session.launchAction === "assign_default_agent" ? { allowedBackends: ["codex" as const,
        ...(backendSummaries ?? []).filter((backend) => backend.kind !== "codex" && defaultAgentBackendSupport(backend.kind, backendSummaries) === "supported")
          .map((backend) => backend.kind)] } : {}),
      excludeFullAccess: session.launchAction === "resume_thread" && !await this.context.canResumeFullAccessThreads(),
    };
    const query: NavigationQuery = session.mode === "projects" || session.mode === "new_project"
      ? { kind: "messaging-projects", ...eligibility, scratchpadFirst: isNewThreadLaunchAction(session.launchAction) }
      : { kind: "messaging-threads", ...eligibility, directoryKey: session.directorySelector ?? session.selectedProject?.directoryKey };
    const publish = async (page: Awaited<ReturnType<MessagingBrowseQueryPool["read"]>>): Promise<void> => {
      if (!stillCurrent()) return;
      session = { ...session, pageIndex: page.pageIndex, ...(page.selectedProject ? { selectedProject: page.selectedProject } : {}) };
      await this.context.store.upsertBrowseSession(session);
      const intent = buildBoundedResumeIntent({ id: this.context.newIntentId("resume"), createdAt: this.context.now(), page, session });
      if (!stillCurrent()) return;
      await this.context.storePendingIntent(intent, undefined, event);
      if (!stillCurrent()) return;
      const result = await this.context.deliver(intent, undefined, event);
      if (!stillCurrent() || !result.surface) {
        return;
      }

      session = { ...session, surface: result.surface, updatedAt: this.context.now() };
      await this.context.store.upsertBrowseSession(session);
      await this.context.store.upsertPendingIntent({
        id: intent.id,
        channel: event.channel,
        intent,
        allowedActorIds: [event.actor.platformUserId],
        createdAt: this.context.now(),
        expiresAt: this.context.now() + this.context.pendingIntentTtlMs,
        surface: result.surface,
      });
    };
    try {
      const page = await this.queryPool.read({ sessionId: session.id, query, owners,
        omittedOwners: canReadRemote ? inventory.omitted : 0, pageSize: session.pageSize, pageIndex: session.pageIndex });
      await publish(page);
    } catch (error) {
      if (stillCurrent()) throw error;
    } finally {
      if (this.browseRenderGenerations.get(session.id) === token) this.browseRenderGenerations.delete(session.id);
    }
  }

  async deliverInvalidBrowseSelection(
    event: MessagingInboundEvent,
  ): Promise<void> {
    await this.context.deliver(
      buildErrorIntent({
        id: this.context.newIntentId("invalid-browse-selection"),
        createdAt: this.context.now(),
        title: "Invalid selection",
        body: "That resume selection is no longer available. Use /resume to refresh.",
        recoverable: true,
      }),
      undefined,
      event,
    );
  }
}
