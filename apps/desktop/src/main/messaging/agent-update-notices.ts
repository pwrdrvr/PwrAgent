import { releaseNotesUrl } from "@pwragent/shared/release-notes";
import type { MessagingBindingRecord } from "@pwragent/messaging-interface";
import type { AppUpdateNotice, AppUpdateNoticeAgent, AppUpdateNoticeAgentIdentity } from "../../shared/app-metadata";
import { createAppUpdateNoticeStore } from "../storage/desktop-messaging-storage";
import { getMainLogger } from "../log";
import { getDesktopMessagingStore } from "./desktop-messaging-store";
import { rememberBoundedKey, type MessagingDeliveryGuard } from "./core/messaging-backend-event-helpers";
import { buildMessagingConversationKey } from "./core/messaging-store";
import { isAcceptedDeliveryOutcome } from "./core/messaging-reply-receipts";
import type { AppUpdateRestartReceipt } from "@pwragent/owner-core/app-update-notice-storage";
import type { AppUpdateCardSurface, AppUpdateNoticeDeliveryResult, ReadyAppUpdateNotice } from "./app-update-controls";

const log = getMainLogger("pwragent:agent-update-notices");

function isLocalBinding(binding: MessagingBindingRecord): boolean {
  return !binding.revokedAt && !binding.privateReplyContinuation
    && binding.federatedThread?.target.scope !== "remote";
}

export async function listAgentUpdateNoticeSettings(): Promise<AppUpdateNoticeAgent[]> {
  const bindings = (await getDesktopMessagingStore().findActiveBindings()).filter(isLocalBinding);
  const conversations = new Map<string, AppUpdateNoticeAgent["conversations"]>();
  const key = ({ backend, threadId }: AppUpdateNoticeAgentIdentity) => JSON.stringify([backend, threadId]);
  for (const binding of bindings) {
    const identity = key(binding);
    const conversation = binding.channel.conversation;
    const entries = conversations.get(identity) ?? [];
    entries.push({ platform: binding.channel.channel, name: conversation.title?.trim() || conversation.id });
    conversations.set(identity, entries);
  }
  return createAppUpdateNoticeStore().listAgents().map((agent) => ({
    ...agent, conversations: conversations.get(key(agent)) ?? [],
  }));
}

export function setAgentUpdateNoticeSetting(
  identity: AppUpdateNoticeAgentIdentity, enabled: boolean,
): boolean {
  return createAppUpdateNoticeStore().setEnabled(identity, enabled);
}

export function appUpdateNoticeText(notice: AppUpdateNotice, machine?: string): string {
  const { version, currentVersion, phase, replaces, train } = notice;
  if (phase === "available") {
    return [
      `PwrAgent update available · v${version}`,
      `${machine ?? "PwrAgent"} is downloading it (running v${currentVersion}, ${train}).`,
      "You'll get another message here when it is ready to install.",
    ].join("\n");
  }
  const releaseNotes = releaseNotesUrl(version);
  return [
    `PwrAgent update ready · v${version}`,
    `${machine ? `Downloaded on ${machine}` : "Downloaded"} (running v${currentVersion}).`
      + (replaces ? ` It replaces v${replaces}, which will not be installed.` : ""),
    "To install, restart PwrAgent on that machine: Restart in the update banner, or Settings → Updates → Restart to Update.",
    ...(releaseNotes ? [`Release notes: ${releaseNotes}`] : []),
  ].join("\n");
}

type NoticeDelivery = (
  binding: MessagingBindingRecord,
  text: string,
  machine: string | undefined,
  guard: MessagingDeliveryGuard,
  ready?: ReadyAppUpdateNotice,
) => Promise<AppUpdateNoticeDeliveryResult>;

function parseReadySurface(value: string | null | undefined): AppUpdateCardSurface | undefined {
  if (!value) return undefined;
  try {
    const card = JSON.parse(value) as Partial<AppUpdateCardSurface> | null;
    return typeof card?.connectionId === "string" && typeof card.surface?.id === "string"
      ? { connectionId: card.connectionId, surface: card.surface } : undefined;
  }
  catch { return undefined; }
}

/** Snapshot eligibility at the updater event. A later opt-in never replays it. */
export function subscribeAgentUpdateNotices(options: {
  subscribe(listener: (notice: AppUpdateNotice) => void): () => void;
  selectDelivery(binding: MessagingBindingRecord): NoticeDelivery | undefined;
  readMachine(): string | undefined;
  onConnection?(listener: () => void): () => void;
  restoreReadyCards?: boolean;
}): () => void {
  const observed = new Set<string>();
  const pending = new Map<string, { notice: AppUpdateNotice; recipients: MessagingBindingRecord[] }>();
  const shutdown = new AbortController();
  const whenCancelled = new Promise<void>((resolve) => {
    shutdown.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  let queued = Promise.resolve();
  const queue = (job: () => Promise<void>) => {
    queued = queued.then(job).catch((error: unknown) => log.warn("app update notice dispatch failed", { error }));
  };
  const flush = async () => {
    if (shutdown.signal.aborted || pending.size === 0) return;
    const ledger = createAppUpdateNoticeStore();
    const store = getDesktopMessagingStore();
    const machine = options.readMachine()?.trim() || undefined;
    for (const [key, { notice, recipients }] of pending) {
      const { phase, version } = notice;
      const text = appUpdateNoticeText(notice, machine);
      const destinations = new Set<string>();
      const waiting: MessagingBindingRecord[] = [];
      await Promise.all(recipients.map(async (binding) => {
        const destination = buildMessagingConversationKey(binding.channel);
        const receipt = { destination, version, phase };
        const previous = ledger.readDelivery(receipt);
        const restore = phase === "ready" && previous?.bindingId === binding.id && options.restoreReadyCards === true;
        if ((previous && !restore) || (phase === "available" && ledger.delivered({ ...receipt, phase: "ready" }))) return;
        const recordAcceptedDelivery = (result: AppUpdateNoticeDeliveryResult): boolean => {
          if (!isAcceptedDeliveryOutcome(result.outcome)) return false;
          const surface = result.card ? JSON.stringify(result.card) : undefined;
          if (!previous || (surface !== undefined && surface !== previous.readySurface)) {
            ledger.recordDelivery(receipt, binding, binding.id, surface);
          }
          return true;
        };
        const guard: MessagingDeliveryGuard = {
          isCancelled: () => shutdown.signal.aborted || !ledger.isEnabled(binding),
          whenCancelled,
          onCancelledDelivery: async (result) => { recordAcceptedDelivery(result); },
        };
        try {
          if (guard.isCancelled() || destinations.has(destination)) return;
          const current = await store.getBinding(binding.id);
          if (!current || !isLocalBinding(current) || guard.isCancelled()
            || current.backend !== binding.backend || current.threadId !== binding.threadId
            || buildMessagingConversationKey(current.channel) !== destination
            || destinations.has(destination)) return;
          const deliver = options.selectDelivery(current);
          if (!deliver) {
            waiting.push(binding);
            return;
          }
          destinations.add(destination);
          const ready = phase === "ready" ? {
            version, ...(restore ? { restore: true as const, previousCard: parseReadySurface(previous?.readySurface) } : {}),
          } : undefined;
          const result = await deliver(current, text, machine, guard, ready);
          if (!recordAcceptedDelivery(result) && !guard.isCancelled() && result.outcome !== "discarded") {
            log.warn("app update notice delivery failed", { bindingId: binding.id, outcome: result.outcome, version, phase });
          }
        } catch (error) {
          log.warn("app update notice delivery failed", { bindingId: binding.id, version, phase, error });
        }
      }));
      if (waiting.length && !shutdown.signal.aborted) pending.set(key, { notice, recipients: waiting });
      else pending.delete(key);
    }
  };
  const unsubscribeConnection = options.onConnection?.(() => queue(flush));
  const unsubscribe = options.subscribe((notice) => {
    const { phase, version } = notice;
    const key = `${phase}:${version}`;
    if (shutdown.signal.aborted || observed.has(key) || observed.has(`ready:${version}`)) return;
    rememberBoundedKey(observed, key);
    const ledger = createAppUpdateNoticeStore();
    if (!ledger.hasRecipients()) return;
    const optedIn = new Set(ledger.listAgents().filter((agent) => agent.enabled)
      .map(({ backend, threadId }) => JSON.stringify([backend, threadId])));
    const store = getDesktopMessagingStore();
    const snapshot = store.findActiveBindings().then((rows) => rows.filter((binding) => isLocalBinding(binding)
      && optedIn.has(JSON.stringify([binding.backend, binding.threadId])))).catch((error: unknown) => {
      log.warn("could not resolve app update notice destinations", { error });
      return [];
    });
    queue(async () => {
      const recipients = await snapshot;
      if (shutdown.signal.aborted) return;
      if (phase === "ready") {
        pending.delete(`available:${version}`);
        if (notice.replaces) pending.delete(`ready:${notice.replaces}`);
      }
      if (pending.size >= 32) pending.delete(pending.keys().next().value!);
      pending.set(key, { notice, recipients });
      await flush();
    });
  });
  return () => {
    shutdown.abort();
    pending.clear();
    unsubscribeConnection?.();
    unsubscribe();
  };
}

export function reconcileAppUpdateRestart(options: {
  runtimeId: string;
  currentVersion(): string;
  selectDelivery(binding: MessagingBindingRecord): NoticeDelivery | undefined;
  readMachine(): string | undefined;
  onConnection(listener: () => void): () => void;
  isSameConnection(binding: MessagingBindingRecord, connectionId: string): boolean;
}): () => void {
  const shutdown = new AbortController();
  const whenCancelled = new Promise<void>((resolve) => {
    shutdown.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  let reconciling = false;
  let connectionChanged = false;
  const finish = async (key: string, receipt: AppUpdateRestartReceipt): Promise<void> => {
    const ledger = createAppUpdateNoticeStore();
    const binding = await getDesktopMessagingStore().getBinding(receipt.bindingId);
    if (shutdown.signal.aborted) return;
    if (!binding || !isLocalBinding(binding) || !ledger.isEnabled(binding)
      || binding.backend !== receipt.backend || binding.threadId !== receipt.threadId
      || buildMessagingConversationKey(binding.channel) !== receipt.destination) {
      ledger.removeRestartReceipt(key, receipt);
      return;
    }
    const observed = ledger.observeRestartReceipt(key, receipt, options.currentVersion());
    if (!observed) return;
    const deliver = options.selectDelivery(binding);
    if (!deliver) return;
    if (!options.isSameConnection(binding, receipt.connectionId)) {
      ledger.removeRestartReceipt(key, observed);
      return;
    }
    const installed = observed.observedVersion === receipt.version;
    const text = installed
      ? `PwrAgent update installed · v${receipt.version}\nPwrAgent restarted on v${receipt.version}.`
      : `PwrAgent update did not install · v${receipt.version}\nPwrAgent restarted on v${observed.observedVersion}. To try again on the desktop, use Settings → Updates.`;
    const result = await deliver(binding, text, options.readMachine(),
      { isCancelled: () => shutdown.signal.aborted, whenCancelled }, installed ? undefined : { version: receipt.version });
    if (isAcceptedDeliveryOutcome(result.outcome)) ledger.removeRestartReceipt(key, observed);
  };
  const onConnection = () => {
    if (shutdown.signal.aborted) return;
    if (reconciling) {
      connectionChanged = true;
      return;
    }
    try {
      const receipts = createAppUpdateNoticeStore().listRestartReceipts()
        .filter(({ receipt }) => receipt.runtimeId !== options.runtimeId);
      if (!receipts.length) return;
      reconciling = true;
      void Promise.all(receipts.map(({ key, receipt }) => finish(key, receipt)
        .catch((error: unknown) => log.warn("app update restart result could not be delivered", { error })))).finally(() => {
        reconciling = false;
        if (connectionChanged) {
          connectionChanged = false;
          onConnection();
        }
      });
    } catch (error) {
      log.warn("app update restart receipt could not be read", { error });
    }
  };
  const unsubscribe = options.onConnection(onConnection);
  onConnection();
  return () => { shutdown.abort(); unsubscribe(); };
}
