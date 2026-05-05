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
    const threadKey = buildThreadIdentityKey(thread.source, thread.id);
    result[threadKey] = bindings.map((binding) => ({
      bindingId: binding.id,
      platform: binding.channel.channel,
      conversationTitle:
        binding.channel.conversation.title
        ?? binding.threadDisplay?.threadTitle
        ?? binding.displayName,
      activeAt: binding.updatedAt,
    }));
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
