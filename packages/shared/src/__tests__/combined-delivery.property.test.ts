import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppServerThreadMessageOrigin, AppServerTurnInputItem } from "../contracts/normalized-app-server";
import {
  combinedDeliveryInput,
  combinedDeliverySenderLine,
  splitCombinedDelivery,
} from "../combined-delivery";

/**
 * The rule: the transcript shows every member of a combined delivery
 * exactly once, in delivery order, with its own sender and its own text.
 * The oracle is the members themselves: framing them and splitting the
 * result must give them back, whether the provider kept each input item
 * or merged all the text into one.
 */

type Member = { input: AppServerTurnInputItem[]; messageOrigin: AppServerThreadMessageOrigin; createdAt: number };
type Part = { type: "text"; text: string } | { type: "image"; url: string };

const originArb: fc.Arbitrary<AppServerThreadMessageOrigin> = fc.oneof(
  fc.record({
    kind: fc.constant("agent" as const),
    sourceThread: fc.record({
      backend: fc.constantFrom("codex" as const, "claude" as const),
      threadId: fc.uuid(),
      title: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
    }),
  }),
  fc.constant({ kind: "sub-agent" as const }),
  fc.record({ kind: fc.constant("pwragent" as const), dependencyId: fc.uuid() }),
);

const membersArb = (images: boolean) => fc.array(fc.record({
  input: fc.array(
    images
      ? fc.oneof(
        fc.string({ minLength: 1, maxLength: 60 }).map((text): AppServerTurnInputItem => ({ type: "text", text })),
        fc.webUrl().map((url): AppServerTurnInputItem => ({ type: "image", url })),
      )
      : fc.string({ minLength: 1, maxLength: 60 }).map((text): AppServerTurnInputItem => ({ type: "text", text })),
    { minLength: 1, maxLength: 3 },
  ),
  messageOrigin: originArb,
  createdAt: fc.integer({ min: 1_700_000_000_000, max: 1_900_000_000_000 }),
}), { minLength: 2, maxLength: 6 });

const delivered = (members: Member[]) => members.map((member) => ({
  origin: member.messageOrigin,
  receivedAt: member.createdAt,
  inputItemCount: member.input.length,
}));

const toPart = (item: AppServerTurnInputItem): Part => item.type === "text"
  ? { type: "text", text: item.text }
  : { type: "image", url: item.type === "image" ? item.url : "" };
const textOf = (part: Part) => part.type === "text" ? part.text : undefined;
const textPart = (text: string): Part => ({ type: "text", text });

describe("combined delivery framing", () => {
  it("splits back into each member's own items when the provider keeps them", () => {
    fc.assert(fc.property(membersArb(true), (members) => {
      const parts = combinedDeliveryInput(members).map(toPart);
      const split = splitCombinedDelivery(parts, delivered(members), textOf, textPart);
      expect(split?.map((member) => [member.origin, member.receivedAt, member.parts]))
        .toEqual(members.map((member) => [member.messageOrigin, member.createdAt, member.input.map(toPart)]));
    }));
  });

  it("splits back into each member's own text when the provider merged it", () => {
    fc.assert(fc.property(membersArb(false), (members) => {
      // A member's own text never contains a later member's exact sender line.
      fc.pre(members.every((member) => members.every((other, index) =>
        member.input.every((item) => item.type !== "text"
          || !item.text.includes(combinedDeliverySenderLine(index, members.length, other.messageOrigin, other.createdAt))))));
      const merged = combinedDeliveryInput(members).map((item) => item.type === "text" ? item.text : "").join("\n");
      const split = splitCombinedDelivery([textPart(merged)], delivered(members), textOf, textPart);
      expect(split?.map((member) => [member.origin, member.parts]))
        .toEqual(members.map((member) => [member.messageOrigin,
          [textPart(member.input.map((item) => item.type === "text" ? item.text : "").join("\n"))]]));
    }));
  });

  it("leaves a message alone when a recorded time is outside the Date range", () => {
    fc.assert(fc.property(membersArb(true), fc.constantFrom(1e16, -1e16, Number.MAX_SAFE_INTEGER), (members, receivedAt) => {
      const parts = combinedDeliveryInput(members).map(toPart);
      const broken = delivered(members).map((member, index) => index === 0 ? { ...member, receivedAt } : member);
      expect(splitCombinedDelivery(parts, broken, textOf, textPart)).toBeUndefined();
    }));
  });

  it("leaves a message alone when it does not have the recorded layout", () => {
    fc.assert(fc.property(membersArb(true), fc.string(), (members, other) => {
      expect(splitCombinedDelivery([textPart(other)], delivered(members), textOf, textPart)).toBeUndefined();
      expect(splitCombinedDelivery(combinedDeliveryInput(members).map(toPart), undefined, textOf, textPart)).toBeUndefined();
    }));
  });
});
