import type { MessagingBindingRecord } from "@pwragent/messaging-interface";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";

type Thread = { backend: AppServerBackendKind; threadId: string };
type NamedBindingReader = (thread?: Thread, includeOffline?: boolean) => Promise<MessagingBindingRecord[]>;

let reader: NamedBindingReader | undefined;
let bindingsRevision = 0;

export function noteMessagingBindingsChange(): void {
  bindingsRevision += 1;
}

export function readMessagingBindingsRevision(): number {
  return bindingsRevision;
}

export function setNamedMessagingBindingReader(next: NamedBindingReader | undefined): void {
  if (reader === next) return;
  reader = next;
  noteMessagingBindingsChange();
}

export async function listNamedMessagingBindings(thread?: Thread, includeOffline = false): Promise<MessagingBindingRecord[]> {
  return await reader?.(thread, includeOffline) ?? [];
}
