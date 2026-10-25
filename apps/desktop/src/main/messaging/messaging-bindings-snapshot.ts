import type { MessagingBindingRecord } from "@pwragent/messaging-interface";
import type {
  AppServerThreadSummary,
  MessagingThreadBindingSummary,
  NavigationThreadSummary,
} from "@pwragent/shared";
import {
  buildThreadIdentityKey,
  isRemoteFederationTarget,
} from "@pwragent/shared";
import {
  compareBindingsByCreation,
  isBindingForThread,
} from "./core/messaging-binding-thread-match";
import { getDesktopMessagingStore } from "./desktop-messaging-store";
import { getMainLogger } from "../log";

const log = getMainLogger("pwragent:messaging-bindings");

/** The thread fields that decide which bindings a row shows. */
type BindableThread = Pick<NavigationThreadSummary, "id" | "source" | "federation">;

/**
 * Build the `messagingBindingsByThreadKey` record for the navigation
 * snapshot and the selected-thread detail. One read of the active bindings
 * serves every thread. Returns `undefined` (rather than an empty object)
 * when nothing is bound: `buildNavigationSnapshot` treats `undefined` and
 * `{}` the same, but `undefined` keeps the hash inputs minimal for users
 * with no messaging configured.
 */
export async function buildMessagingBindingsByThreadKey(
  threads: readonly AppServerThreadSummary[],
): Promise<Record<string, MessagingThreadBindingSummary[]> | undefined> {
  if (threads.length === 0) return undefined;
  const active = await readActiveBindings("navigation snapshot");
  if (!active) return undefined;
  const grouped = groupBindingsByThreadKey(threads, active);
  return grouped.size > 0 ? Object.fromEntries(grouped) : undefined;
}

/**
 * Bindings for the sidebar's owner index, keyed by thread identity. Same
 * read and matching as `buildMessagingBindingsByThreadKey`, so a row and
 * the selected thread's detail show the same chips in the same order.
 */
export async function buildNavigationIndexMessagingBindings(
  threads: readonly NavigationThreadSummary[],
): Promise<Map<string, MessagingThreadBindingSummary[]>> {
  if (threads.length === 0) return new Map();
  const active = await readActiveBindings("navigation index");
  return active ? groupBindingsByThreadKey(threads, active) : new Map();
}

/**
 * Read every active binding once. Chips are an overlay on the list, so a
 * failed read returns `undefined` instead of failing the snapshot. The
 * messaging store is created after app state comes up, so an early read can
 * also land here.
 */
async function readActiveBindings(
  surface: string,
): Promise<MessagingBindingRecord[] | undefined> {
  try {
    return await getDesktopMessagingStore().findActiveBindings();
  } catch (error) {
    log.warn(`messaging bindings unavailable for ${surface}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Group bindings by thread identity. Matching is `isBindingForThread`, the
 * rule the stores' `findActiveBindingsForThread` uses. A binding to a remote
 * federated thread is skipped, and so is a row for another instance's
 * thread: this machine's bindings are not the peer's.
 */
function groupBindingsByThreadKey(
  threads: readonly BindableThread[],
  active: readonly MessagingBindingRecord[],
): Map<string, MessagingThreadBindingSummary[]> {
  const result = new Map<string, MessagingThreadBindingSummary[]>();
  const byThreadId = new Map<string, MessagingBindingRecord[]>();
  for (const binding of active) {
    if (binding.federatedThread && isRemoteFederationTarget(binding.federatedThread.target)) continue;
    const list = byThreadId.get(binding.threadId);
    if (list) list.push(binding);
    else byThreadId.set(binding.threadId, [binding]);
  }
  if (byThreadId.size === 0) return result;
  for (const thread of threads) {
    if (thread.federation?.ref.target.scope === "remote") continue;
    const bindings = byThreadId.get(thread.id)
      ?.filter((binding) => isBindingForThread(binding, { backend: thread.source, threadId: thread.id }))
      .sort(compareBindingsByCreation);
    if (!bindings?.length) continue;
    result.set(buildThreadIdentityKey(thread.source, thread.id), bindings.map(toBindingSummary));
  }
  return result;
}

function toBindingSummary(binding: MessagingBindingRecord): MessagingThreadBindingSummary {
  const conversation = binding.channel.conversation;
  return {
    bindingId: binding.id,
    platform: binding.channel.channel,
    conversationKind: conversation.kind,
    // Title of the conversation NODE itself — topic name, channel
    // name, DM peer name, supergroup name. Renderer falls back to
    // a generic placeholder ("Topic" / "Thread" / "channel") when
    // the adapter hasn't populated this. We intentionally do not
    // fall through to the desktop thread title or actor display
    // name here — those leak unrelated context into the chip.
    conversationTitle: conversation.title,
    parentTitle: conversation.parentTitle,
    ancestorTitle: conversation.ancestorTitle,
    activeAt: binding.updatedAt,
  };
}
