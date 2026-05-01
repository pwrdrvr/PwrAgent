import { MessagingStore } from "./core/messaging-store";
import { resolveDesktopMessagingStorePath } from "../app-server/desktop-state-root";

let messagingStore: MessagingStore | null = null;

export function getDesktopMessagingStore(): MessagingStore {
  if (!messagingStore) {
    messagingStore = new MessagingStore(resolveDesktopMessagingStorePath());
  }

  return messagingStore;
}

export function resetDesktopMessagingStoreForTests(): void {
  messagingStore = null;
}
