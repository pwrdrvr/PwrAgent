import type {
  AppServerThreadSummary,
  MessagingThreadBindingSummary,
} from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
import { getDesktopMessagingStore } from "./desktop-messaging-store";
import { getMainLogger } from "../log";

const log = getMainLogger("pwragent:messaging-bindings");

/**
 * Build the `messagingBindingsByThreadKey` map for the navigation
 * snapshot. Walks the threads in the current snapshot and asks the
 * messaging store for active bindings per thread. Returns `undefined`
 * (rather than an empty object) when nothing is bound — `buildNavigationSnapshot`
 * treats `undefined` and `{}` the same, but `undefined` keeps the hash
 * inputs minimal for users with no messaging configured.
 */
export async function buildMessagingBindingsByThreadKey(
  threads: AppServerThreadSummary[],
): Promise<Record<string, MessagingThreadBindingSummary[]> | undefined> {
  if (threads.length === 0) return undefined;
  let store;
  try {
    store = getDesktopMessagingStore();
  } catch (error) {
    // The messaging store is initialized lazily after the app state is
    // brought up. If we somehow ask for bindings before then, return
    // undefined rather than crashing the navigation snapshot path.
    log.warn("messaging store unavailable for navigation snapshot", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }

  const result: Record<string, MessagingThreadBindingSummary[]> = {};
  let totalBindings = 0;
  for (const thread of threads) {
    let bindings;
    try {
      bindings = await store.findActiveBindingsForThread({
        backend: thread.source,
        threadId: thread.id,
      });
    } catch (error) {
      log.warn("failed to resolve bindings for thread", {
        backend: thread.source,
        threadId: thread.id,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (bindings.length === 0) continue;
    totalBindings += bindings.length;
    const threadKey = buildThreadIdentityKey(thread.source, thread.id);
    result[threadKey] = bindings.map((binding) => {
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
    });
  }
  // One-line diagnostic so a user reporting "I had more bindings than
  // are showing" can compare the desktop's view of bindings to the raw
  // sqlite row count without opening the DB.
  log.info("messaging bindings snapshot", {
    threadCount: threads.length,
    boundThreadCount: Object.keys(result).length,
    totalActiveBindings: totalBindings,
  });
  return Object.keys(result).length > 0 ? result : undefined;
}
