import { releaseNotesUrl } from "@pwragent/shared/release-notes";
import type { MessagingBindingRecord, MessagingDeliveryResult } from "@pwragent/messaging-interface";
import type { AppUpdateNotice, AppUpdateNoticeAgent, AppUpdateNoticeAgentIdentity } from "../../shared/app-metadata";
import { createAppUpdateNoticeStore } from "../storage/desktop-messaging-storage";
import { getMainLogger } from "../log";
import { getDesktopMessagingStore } from "./desktop-messaging-store";
import { rememberBoundedKey, type MessagingDeliveryGuard } from "./core/messaging-backend-event-helpers";
import { buildMessagingConversationKey } from "./core/messaging-store";
import { isAcceptedDeliveryOutcome } from "./core/messaging-reply-receipts";

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
) => Promise<MessagingDeliveryResult>;

/** Snapshot eligibility at the updater event. A later opt-in never replays it. */
export function subscribeAgentUpdateNotices(options: {
  subscribe(listener: (notice: AppUpdateNotice) => void): () => void;
  selectDelivery(binding: MessagingBindingRecord): NoticeDelivery | undefined;
  readMachine(): string | undefined;
}): () => void {
  const observed = new Set<string>();
  const shutdown = new AbortController();
  const whenCancelled = new Promise<void>((resolve) => {
    shutdown.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  let queued = Promise.resolve();
  const unsubscribe = options.subscribe((notice) => {
    const { phase, version } = notice;
    const key = `${phase}:${version}`;
    if (shutdown.signal.aborted || observed.has(key) || observed.has(`ready:${version}`)) return;
    rememberBoundedKey(observed, key);
    const ledger = createAppUpdateNoticeStore();
    if (!ledger.hasRecipients()) return;
    const store = getDesktopMessagingStore();
    const snapshot = store.findActiveBindings().then((rows) => rows.flatMap((binding) => {
      if (!isLocalBinding(binding) || !ledger.isEnabled(binding)) return [];
      const deliver = options.selectDelivery(binding);
      return deliver ? [{ binding, deliver }] : [];
    })).catch((error: unknown) => {
      log.warn("could not resolve app update notice destinations", { error });
      return [];
    });
    queued = queued.then(async () => {
      const machine = options.readMachine()?.trim() || undefined;
      const text = appUpdateNoticeText(notice, machine);
      const destinations = new Set<string>();
      await Promise.all((await snapshot).map(async ({ binding, deliver }) => {
        const destination = buildMessagingConversationKey(binding.channel);
        const receipt = { destination, version, phase };
        const recordAcceptedDelivery = (result: MessagingDeliveryResult): boolean => {
          if (!isAcceptedDeliveryOutcome(result.outcome)) return false;
          ledger.recordDelivery(receipt, binding, binding.id);
          return true;
        };
        const guard: MessagingDeliveryGuard = {
          isCancelled: () => shutdown.signal.aborted || !ledger.isEnabled(binding),
          whenCancelled,
          onCancelledDelivery: async (result) => { recordAcceptedDelivery(result); },
        };
        try {
          if (guard.isCancelled() || destinations.has(destination)
            || ledger.delivered(receipt)
            || (phase === "available" && ledger.delivered({ ...receipt, phase: "ready" }))) return;
          const current = await store.getBinding(binding.id);
          if (!current || !isLocalBinding(current) || guard.isCancelled()
            || current.backend !== binding.backend || current.threadId !== binding.threadId
            || buildMessagingConversationKey(current.channel) !== destination
            || destinations.has(destination)) return;
          destinations.add(destination);
          const result = await deliver(current, text, machine, guard);
          if (!recordAcceptedDelivery(result) && !guard.isCancelled()) {
            log.warn("app update notice delivery failed", { bindingId: binding.id, outcome: result.outcome, version, phase });
          }
        } catch (error) {
          log.warn("app update notice delivery failed", { bindingId: binding.id, version, phase, error });
        }
      }));
    }).catch((error: unknown) => log.warn("app update notice dispatch failed", { error }));
  });
  return () => {
    shutdown.abort();
    unsubscribe();
  };
}
