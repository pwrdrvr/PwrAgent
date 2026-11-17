import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { extractThreadReplayFromReadResult } from "../codex-app-server/client";

const startedAt = Date.parse("2026-11-17T02:09:40Z");

function replayUserMessages(laterTimestamps: Array<number | undefined>, openingTime?: number) {
  return extractThreadReplayFromReadResult({
    thread: {
      id: "thread",
      turns: [{
        id: "turn",
        startedAt,
        items: [openingTime, ...laterTimestamps].flatMap((createdAt, index) => [
          {
            type: "userMessage",
            id: `user-${index}`,
            content: [{ type: "text", text: index === 0 ? "Start work" : `Steer ${index}` }],
            ...(createdAt !== undefined ? { createdAt } : {}),
          },
          {
            type: "agentMessage",
            id: `assistant-${index}`,
            text: `Working on request ${index}`,
            phase: "commentary",
          },
        ]),
      }],
    },
  });
}

describe("Codex user message timestamp provenance", () => {
  it("does not label an untimed late steer with the opening prompt's time", () => {
    const replay = replayUserMessages([undefined]);
    expect(replay.messages.filter((message) => message.role === "user").map((message) => message.createdAt))
      .toEqual([startedAt, undefined]);
    expect(replay.entries.filter((entry) => entry.type === "message" && entry.role === "user").map((entry) => entry.createdAt))
      .toEqual([startedAt, undefined]);
  });

  it("only uses turn start for the opening prompt, preserving item times for every steer", () => {
    // Oracle: protocol item timestamps own later send times. Their absence
    // cannot establish that a message arrived at the turn's opening boundary.
    fc.assert(fc.property(
      fc.option(fc.integer({ min: 0, max: 1_000 }), { nil: undefined }),
      fc.array(fc.option(fc.integer({ min: 1, max: 86_400_000 }), { nil: undefined }), {
        minLength: 1,
        maxLength: 12,
      }),
      (openingDelay, delays) => {
        const openingTime = openingDelay === undefined ? undefined : startedAt + openingDelay;
        let arrivalTime = openingTime ?? startedAt;
        const times = delays.map((delay) => {
          arrivalTime += delay ?? 1;
          return delay === undefined ? undefined : arrivalTime;
        });
        const replay = replayUserMessages(times, openingTime);
        const expected = [openingTime ?? startedAt, ...times];
        expect(replay.messages.filter((message) => message.role === "user").map((message) => message.createdAt))
          .toEqual(expected);
        expect(replay.entries.filter((entry) => entry.type === "message" && entry.role === "user").map((entry) => entry.createdAt))
          .toEqual(expected);
      },
    ));
  });
});
