import type {
  AppServerThreadMessageOrigin,
  AppServerTurnInputItem,
} from "./contracts/normalized-app-server";

/**
 * A combined delivery: several waiting messages from agents, monitors and
 * PwrAgent that reach a thread as one input. The owner frames them here and
 * the transcript splits them back here, so both sides agree on the layout.
 *
 * Layout: one preamble item, then for each message one line naming its
 * sender, followed by that message's own input items.
 */

type DeliveryMember = {
  input: AppServerTurnInputItem[];
  messageOrigin?: AppServerThreadMessageOrigin;
  createdAt: number;
};

type DeliveredMessage = NonNullable<AppServerThreadMessageOrigin["deliveredMessages"]>[number];

export function combinedDeliveryPreamble(count: number): string {
  return `${count} messages arrived for this thread and are delivered together. Each starts with a line naming its sender.`;
}

/** The line naming one message's sender, ahead of its own input. */
export function combinedDeliverySenderLine(
  index: number,
  count: number,
  origin: AppServerThreadMessageOrigin | undefined,
  receivedAt: number,
): string {
  return `Message ${index + 1} of ${count} · from ${describeDeliverySender(origin)} · received ${new Date(receivedAt).toISOString()}`;
}

function describeDeliverySender(origin: AppServerThreadMessageOrigin | undefined): string {
  const source = origin?.sourceThread;
  if (source) {
    return `thread "${source.title ?? source.threadId}" (${source.backend}, thread ${source.threadId}${
      source.instanceId ? `, instance ${source.instanceLabel ?? source.instanceId}` : ""})`;
  }
  if (origin?.kind === "sub-agent") return "a PwrAgent monitor";
  if (origin?.kind === "pwragent") return "PwrAgent";
  return "another thread";
}

/**
 * One input for several queued messages. A single message goes as it was
 * sent.
 */
export function combinedDeliveryInput(members: readonly DeliveryMember[]): AppServerTurnInputItem[] {
  if (members.length === 1) return members[0]!.input.map((item) => ({ ...item }));
  return [
    { type: "text", text: combinedDeliveryPreamble(members.length) },
    ...members.flatMap((member, index): AppServerTurnInputItem[] => [
      { type: "text", text: combinedDeliverySenderLine(index, members.length, member.messageOrigin, member.createdAt) },
      ...member.input.map((item) => ({ ...item })),
    ]),
  ];
}

export type CombinedDeliveryMember<Part> = {
  origin: AppServerThreadMessageOrigin;
  receivedAt: number;
  parts: Part[];
};

/**
 * Splits a delivered message back into its members, using the boundaries
 * its origin recorded. Returns undefined when the parts do not have the
 * recorded layout (an older delivery, or a provider that merged the items),
 * so the caller shows the message as one.
 *
 * When the provider merged every text item into one, the sender lines it
 * wrote are still there, in order, and mark the boundaries instead.
 */
export function splitCombinedDelivery<Part extends { type: string }>(
  parts: readonly Part[],
  delivered: readonly DeliveredMessage[] | undefined,
  textOf: (part: Part) => string | undefined,
  textPart: (text: string) => Part,
): CombinedDeliveryMember<Part>[] | undefined {
  if (!delivered || delivered.length < 2) return undefined;
  // A peer-asserted time outside the Date range cannot name a sender line.
  if (delivered.some((member) => !Number.isFinite(new Date(member.receivedAt).getTime()))) return undefined;
  const count = delivered.length;
  const expected = 1 + delivered.reduce((total, member) => total + 1 + member.inputItemCount, 0);
  if (parts.length === expected && textOf(parts[0]!) === combinedDeliveryPreamble(count)) {
    const members: CombinedDeliveryMember<Part>[] = [];
    let cursor = 1;
    for (const [index, member] of delivered.entries()) {
      const line = textOf(parts[cursor]!);
      if (line !== combinedDeliverySenderLine(index, count, member.origin, member.receivedAt)) return undefined;
      cursor += 1;
      members.push({
        origin: member.origin,
        receivedAt: member.receivedAt,
        parts: parts.slice(cursor, cursor + member.inputItemCount),
      });
      cursor += member.inputItemCount;
    }
    return members;
  }
  // One merged text: find each sender line, in order, at a line start.
  const texts = parts.flatMap((part) => {
    const text = textOf(part);
    return text === undefined ? [] : [text];
  });
  if (texts.length !== 1 || texts.length !== parts.length) return undefined;
  const text = texts[0]!;
  if (!text.startsWith(combinedDeliveryPreamble(count))) return undefined;
  const lines = delivered.map((member, index) =>
    combinedDeliverySenderLine(index, count, member.origin, member.receivedAt));
  const starts: number[] = [];
  let from = combinedDeliveryPreamble(count).length;
  for (const line of lines) {
    const at = text.indexOf(`\n${line}`, from - 1);
    if (at < 0) return undefined;
    starts.push(at + 1);
    from = at + 1 + line.length;
  }
  return delivered.map((member, index) => {
    const bodyStart = starts[index]! + lines[index]!.length;
    const bodyEnd = index + 1 < starts.length ? starts[index + 1]! - 1 : text.length;
    const body = text.slice(bodyStart, bodyEnd).replace(/^\n/, "");
    return { origin: member.origin, receivedAt: member.receivedAt, parts: body ? [textPart(body)] : [] };
  });
}
