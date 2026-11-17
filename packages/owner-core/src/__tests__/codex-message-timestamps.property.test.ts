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

  it("does not treat the first user message after provider work as the opening prompt", () => {
    fc.assert(fc.property(
      fc.constantFrom(
        { type: "agentMessage", id: "work", text: "Working.", phase: "commentary" },
        { type: "enteredReviewMode", id: "work", review: "Review current changes" },
        { type: "commandExecution", id: "work", command: "pwd", status: "completed" },
      ),
      (work) => {
        const replay = extractThreadReplayFromReadResult({ thread: { turns: [{
          id: "turn", startedAt, items: [work, {
            type: "userMessage", id: "steer", text: "Also check this.",
          }],
        }] } });
        const steer = replay.entries.find((entry) => entry.id === "steer");
        expect(steer).toBeDefined();
        expect(steer?.createdAt).toBeUndefined();
        expect(replay.messages.find((message) => message.id === "steer")?.createdAt).toBeUndefined();
      },
    ));
  });
});

describe("Codex result timestamp provenance", () => {
  it("does not date a review result at turn start when completion time is unknown", () => {
    const replay = extractThreadReplayFromReadResult({ thread: { turns: [{
      id: "turn", startedAt, items: [{ type: "exitedReviewMode", id: "review", review: "No findings." }],
    }] } });
    expect(replay.entries).toHaveLength(1);
    expect(replay.entries[0]?.createdAt).toBeUndefined();
  });

  it("does not date an image-only reply at turn start when completion time is unknown", () => {
    const replay = extractThreadReplayFromReadResult({ thread: { turns: [{
      id: "turn", startedAt, items: [{
        type: "response_item",
        payload: {
          type: "custom_tool_call_output", call_id: "image",
          output: [{ type: "input_image", image_url: "data:image/png;base64,AQID" }],
        },
      }],
    }] } });
    const images = replay.entries.filter((entry) => entry.type === "message" && entry.role === "assistant");
    expect(images).toHaveLength(1);
    expect(images[0]?.createdAt).toBeUndefined();
  });

  it("only dates review results from their item or turn completion boundary", () => {
    fc.assert(fc.property(
      fc.option(fc.integer({ min: 1, max: 86_400_000 }), { nil: undefined }),
      fc.boolean(),
      (duration, hasItemTime) => {
        const completedAt = duration === undefined ? undefined : startedAt + duration;
        const itemTime = hasItemTime ? startedAt + 1 : undefined;
        const replay = extractThreadReplayFromReadResult({ thread: { turns: [{
          id: "turn", startedAt, completedAt, items: [{
            type: "exitedReviewMode", id: "review", review: "No findings.", createdAt: itemTime,
          }],
        }] } });
        expect(replay.entries).toHaveLength(1);
        expect(replay.entries[0]?.createdAt).toBe(itemTime ?? completedAt);
      },
    ));
  });

  it("only dates image-only replies from a known completion boundary", () => {
    fc.assert(fc.property(
      fc.option(fc.integer({ min: 1, max: 86_400_000 }), { nil: undefined }),
      (duration) => {
        const completedAt = duration === undefined ? undefined : startedAt + duration;
        const replay = extractThreadReplayFromReadResult({ thread: { turns: [{
          id: "turn", startedAt, completedAt, items: [{
            type: "response_item",
            payload: {
              type: "custom_tool_call_output", call_id: "image",
              output: [{ type: "input_image", image_url: "data:image/png;base64,AQID" }],
            },
          }],
        }] } });
        const images = replay.entries.filter((entry) => entry.type === "message" && entry.role === "assistant");
        expect(images).toHaveLength(1);
        expect(images[0]?.createdAt).toBe(completedAt);
      },
    ));
  });
});
