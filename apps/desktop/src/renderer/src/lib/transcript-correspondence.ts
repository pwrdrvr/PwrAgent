import type { AppServerThreadEntry, AppServerThreadMessage, AppServerThreadMessageEntry } from "@pwragent/shared/contracts/normalized-app-server";

export function isCorrespondenceMessage(message: AppServerThreadMessage): boolean {
  return message.origin?.systemReason === "thread-correspondence";
}

export function isCorrespondenceEntry(entry: AppServerThreadEntry): entry is AppServerThreadMessageEntry {
  return entry.id.startsWith("correspondence:") && entry.type === "message" && isCorrespondenceMessage(entry);
}

/** A delivery revision changes the heading while the owning row keeps its placement and attachments. */
export function applyCorrespondenceRevision<Message extends AppServerThreadMessage>(
  row: Message,
  incoming: AppServerThreadMessage,
  acceptUnversioned = false,
): Message {
  if (row.id !== incoming.id || !isCorrespondenceMessage(row) || !isCorrespondenceMessage(incoming)) return row;
  const revision = incoming.origin?.correspondenceRevision;
  const current = row.origin?.correspondenceRevision;
  if (revision === undefined ? current !== undefined || !acceptUnversioned : revision <= (current ?? 0)) return row;
  return {
    ...row,
    origin: { ...row.origin!, correspondenceRevision: revision },
    text: incoming.text,
    parts: (row.parts ?? incoming.parts)?.map((part) => part.type === "text" ? { ...part, text: incoming.text } : part),
  };
}
