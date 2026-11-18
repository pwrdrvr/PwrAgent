import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { bindingWithInboundRoutingState, isMissingTurnTargetStartError, parseMentionCommand, parseTextCommand, parseTextCommandArgs, requestsExplicitPrivateResponse } from "../messaging/core/messaging-inbound-helpers";
import { messagingInboundHarness } from "./fixtures/messaging-inbound-harness";

describe("messaging inbound pure rules", () => {
  it("keeps explicit slash arguments while interpreting only a bare known mention verb as a command", () => {
    const words = fc.array(fc.stringMatching(/^[a-z]{1,8}$/), { minLength: 1, maxLength: 4 });
    fc.assert(fc.property(fc.constantFrom("help", "status", "new"), words, fc.constantFrom(" ", "\t", "\n"), (verb, args, space) => {
      const text = ` ${"/" + verb.toUpperCase()}${space}${args.join(space)} `;
      expect(parseTextCommand(text)).toBe(verb);
      expect(parseTextCommandArgs(text)).toEqual(args);
      expect(parseMentionCommand(`${verb}${space}${args.join(space)}`)).toBeUndefined();
      expect(parseMentionCommand(` ${verb} `)).toEqual({ command: verb, args: [] });
    }));
  });

  it("requires affirmative private delivery language in the current clause", async () => {
    const f = await messagingInboundHarness();
    try {
      fc.assert(fc.property(fc.constantFrom("DM me", "reply privately", "send only to me"), fc.constantFrom("do not", "never", "don't"), (request, negation) => {
        expect(requestsExplicitPrivateResponse(f.event(request))).toBe(true);
        expect(requestsExplicitPrivateResponse(f.event(`${negation} ${request}`))).toBe(false);
        expect(requestsExplicitPrivateResponse(f.event(`${negation} publish this. ${request}`))).toBe(true);
      }));
    } finally { await f.close(); }
  });

  it("requires missing-thread evidence to name the actual target and keeps routing replacement in memory", async () => {
    const f = await messagingInboundHarness();
    try {
      const binding = (await f.store.getBinding("fixture-binding"))!;
      fc.assert(fc.property(fc.constantFrom("thread not found", "unknown thread", "thread was deleted"), phrase => {
        expect(isMissingTurnTargetStartError(`${phrase}: ${binding.threadId}`, binding)).toBe(true);
        expect(isMissingTurnTargetStartError(`${phrase}: unrelated-target`, binding)).toBe(false);
        const routing = { opaque: { fixture: phrase } };
        expect(bindingWithInboundRoutingState(binding, routing)).toEqual({ ...binding, routingState: routing });
        expect(binding.routingState).toBeUndefined();
        expect(bindingWithInboundRoutingState(binding, undefined)).toBe(binding);
      }));
    } finally { await f.close(); }
  });
});
