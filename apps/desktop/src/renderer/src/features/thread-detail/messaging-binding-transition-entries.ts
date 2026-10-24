import type {
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
  MessagingConversationKind,
  ThreadMessagingBindingTransition,
} from "@pwragent/shared";
import { formatMessagingPlatformName } from "../../lib/messaging-platform-branding";
import { insertSyntheticEntriesByTime } from "./synthetic-transcript-entries";

export const MESSAGING_BINDING_TRANSITION_ENTRY_PREFIX =
  "messaging-binding-transition-";

const CONVERSATION_KIND_LABELS: Record<MessagingConversationKind, string> = {
  channel: "channel",
  dm: "DM",
  thread: "thread",
  topic: "topic",
};

function formatConversationLabel(
  transition: ThreadMessagingBindingTransition,
): string {
  const titles = [
    transition.ancestorTitle,
    transition.parentTitle,
    transition.conversationTitle,
  ].filter((title): title is string => Boolean(title?.trim()));

  if (titles.length > 0) {
    return titles.join(" / ");
  }

  return transition.conversationKind
    ? CONVERSATION_KIND_LABELS[transition.conversationKind]
    : "conversation";
}

function summarizeTransition(
  transition: ThreadMessagingBindingTransition,
): string {
  const platform = formatMessagingPlatformName(transition.platform);
  const conversation = formatConversationLabel(transition);
  return transition.action === "bound"
    ? `Channel bound: ${platform} - ${conversation}`
    : `Channel unbound: ${platform} - ${conversation}`;
}

export function buildMessagingBindingTransitionActivityEntries(
  transitions: ThreadMessagingBindingTransition[] | undefined,
): AppServerThreadActivityEntry[] {
  if (!transitions || transitions.length === 0) {
    return [];
  }
  return transitions.map((transition) => ({
    type: "activity",
    id: `${MESSAGING_BINDING_TRANSITION_ENTRY_PREFIX}${transition.id}`,
    summary: summarizeTransition(transition),
    createdAt: transition.occurredAt,
    details: [],
  }));
}

export function injectMessagingBindingTransitions(
  entries: AppServerThreadEntry[],
  transitions: ThreadMessagingBindingTransition[] | undefined,
): AppServerThreadEntry[] {
  const synthetic = buildMessagingBindingTransitionActivityEntries(transitions);
  if (synthetic.length === 0) {
    return entries;
  }
  return insertSyntheticEntriesByTime(entries, synthetic);
}

export function isMessagingBindingTransitionEntry(
  entry: AppServerThreadEntry,
): boolean {
  return entry.id.startsWith(MESSAGING_BINDING_TRANSITION_ENTRY_PREFIX);
}
