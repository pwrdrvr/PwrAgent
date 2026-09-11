import { isDeepStrictEqual } from "node:util";
import type { AppServerReadThreadResponse, AppServerThreadMessage } from "@pwragent/shared";

type MessageReference = { entryIndex: number; fields: string[] };
type TextReference = { messageIndex: number };

/** A replay carries message content once, in its ordered transcript entries. */
export type FederationThreadReadResponse = Omit<AppServerReadThreadResponse, "replay"> & {
  replay: Omit<AppServerReadThreadResponse["replay"], "messages" | "lastUserMessage" | "lastAssistantMessage"> & {
    messages: Array<AppServerThreadMessage | MessageReference>;
    lastUserMessage?: string | TextReference;
    lastAssistantMessage?: string | TextReference;
  };
};

export function projectFederationThreadRead(response: AppServerReadThreadResponse): FederationThreadReadResponse {
  const entries = response.replay.entries;
  const byId = new Map(entries.map((entry, index) => [entry.id, index]));
  const messages = response.replay.messages.map((message): AppServerThreadMessage | MessageReference => {
    const entryIndex = byId.get(message.id);
    if (entryIndex === undefined) return message;
    const entry = entries[entryIndex];
    if (entry.type !== "message") return message;
    const fields = Object.keys(message).filter((field) => Reflect.get(message, field) !== undefined);
    // Preserve the exact message shape, including omitted optional fields.
    // Standalone messages or messages differing from their entry stay inline.
    if (!fields.every((field) => isDeepStrictEqual(
      Reflect.get(message, field), Reflect.get(entry, field),
    ))) return message;
    const reference = { entryIndex, fields };
    return JSON.stringify(reference).length < JSON.stringify(message).length ? reference : message;
  });
  const textReference = (text: string | undefined): string | TextReference | undefined => {
    if (text === undefined) return undefined;
    const messageIndex = response.replay.messages.findIndex((message) => message.text === text);
    const reference = { messageIndex };
    return messageIndex >= 0 && JSON.stringify(reference).length < JSON.stringify(text).length ? reference : text;
  };
  return {
    ...response,
    replay: {
      ...response.replay,
      messages,
      ...(response.replay.lastUserMessage !== undefined ? { lastUserMessage: textReference(response.replay.lastUserMessage) } : {}),
      ...(response.replay.lastAssistantMessage !== undefined ? { lastAssistantMessage: textReference(response.replay.lastAssistantMessage) } : {}),
    },
  };
}

export function materializeFederationThreadRead(response: FederationThreadReadResponse): AppServerReadThreadResponse {
  const { lastUserMessage, lastAssistantMessage, ...replay } = response.replay;
  const messages = response.replay.messages.map((message): AppServerThreadMessage => {
    if (!("entryIndex" in message)) return message;
    const entry = response.replay.entries[message.entryIndex];
    if (!Number.isInteger(message.entryIndex) || !entry || entry.type !== "message"
      || !Array.isArray(message.fields)
      || !["id", "role", "text"].every((field) => message.fields.includes(field))
      || !message.fields.every((field) => typeof field === "string" && Object.hasOwn(entry, field)
        && !["__proto__", "constructor", "prototype"].includes(field))) {
      throw new Error("Invalid federation transcript message reference.");
    }
    return Object.fromEntries(message.fields.map((field) => [field, Reflect.get(entry, field)])) as AppServerThreadMessage;
  });
  const text = (value: string | TextReference | undefined): string | undefined => {
    if (value === undefined || typeof value === "string") return value;
    if (!Number.isInteger(value.messageIndex) || !messages[value.messageIndex]) {
      throw new Error("Invalid federation transcript text reference.");
    }
    return messages[value.messageIndex].text;
  };
  return {
    ...response,
    replay: {
      ...replay,
      messages,
      ...(lastUserMessage !== undefined ? { lastUserMessage: text(lastUserMessage) } : {}),
      ...(lastAssistantMessage !== undefined ? { lastAssistantMessage: text(lastAssistantMessage) } : {}),
    },
  };
}
