import type { MessagingCausalSourceRef } from "@pwragent/shared";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { createMessagingRequestStorage } from "../../src/main/storage/desktop-messaging-storage";
import { selectRequestProfile } from "./messaging-request-profile";

// Runs inside Electron with its own native dependency. This imports the actual
// factory, private specialization and host policy; no SQLite behavior is copied.
export function exerciseRequestFactory(dbPath: string, ref: MessagingCausalSourceRef, mutate: boolean) {
  const db = StateDb.open(dbPath);
  selectRequestProfile(db);
  try {
    const store = createMessagingRequestStorage();
    selectRequestProfile(undefined);
    const source = store.get(ref)!;
    const before = store.destination(source, source.selector);
    if (!mutate) return { source, before };
    const uncertain = store.claimAttachment([ref.requestId, "portable-uncertain"]);
    const completed = store.claimAttachment([ref.requestId, "portable-completed"]);
    const input = { id: "electron-human", kind: "text" as const, text: "Private Electron instructions", receivedAt: 300,
      actor: { platformUserId: "invented-human" }, channel: source.event.channel,
      routingState: { opaque: { route: "invented-channel", api_key: "Private Electron credential" } } };
    const created = store.remember({ agent: source.agent, connectionId: source.connectionId, event: input })!;
    const duplicate = store.remember({ agent: source.agent, connectionId: source.connectionId, event: { ...input, receivedAt: 999 } });
    const bot = store.remember({ agent: source.agent, connectionId: source.connectionId,
      event: { ...input, id: "electron-bot", actor: { ...input.actor, isBot: true } } });
    const claim = store.claimAttachment([ref.requestId, "electron-outcome"]);
    store.finishAttachment(claim.id, { ok: false, error: { code: "unsupported_operation", message: "Invented Electron outcome" } });
    store.finishAttachment(claim.id, { ok: false, error: { code: "unsupported_operation", message: "Must not replace first outcome" } });
    return { source, before, uncertain, completed, created, duplicate, bot, claim,
      after: store.destination(source, source.selector), page: store.list(source, 26) };
  } finally { selectRequestProfile(undefined); db.close(); }
}
