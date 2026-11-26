import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppServerThreadMessagePart } from "@pwragent/shared/contracts/normalized-app-server";
import {
  AcpSessionReplayNormalizer,
  acpReplayPromptTextDigest,
  type AcpReplayPromptIdentity,
} from "../acp/acp-session-normalizer";

describe("ACP user image session/load replay properties", () => {
  it("reattaches saved image parts and suppresses split filename chunks across arbitrary session/load sequences", () => {
    const safeWord = fc.constantFrom("Continue", "Check this", "Try again", "Fix it");
    const safeFile = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_-]{1,14}\.png$/);
    const turnGen = fc.record({
      text: fc.option(safeWord, { nil: "" }),
      images: fc.array(safeFile, { minLength: 0, maxLength: 2 }),
      annotationStyle: fc.constantFrom("attached", "local"),
      providerReplaysImageBlock: fc.boolean(),
      providerTimestamps: fc.boolean(),
    }).filter((turn) => turn.text.length > 0 || turn.images.length > 0);

    fc.assert(
      fc.property(
        fc.array(turnGen, { minLength: 1, maxLength: 5 }),
        fc.boolean(),
        (turns, omitTextOnlyFromReplayPrompts) => {
        const allReplayPrompts: AcpReplayPromptIdentity[] = turns.map((turn, index) => ({
          turnId: `turn-${index}`,
          receivedAt: 1_700_000_000_000 + index * 60_000,
          textDigest: acpReplayPromptTextDigest(turn.text),
          ...(turn.images.length > 0
            ? {
                attachmentParts: turn.images.map((name, imageIndex): AppServerThreadMessagePart => ({
                  type: "image",
                  alt: name,
                  url: `pwragent-image://file/%2Ftmp%2F${index}-${imageIndex}-${encodeURIComponent(name)}`,
                })),
              }
            : {}),
        }));
        const replayPrompts = omitTextOnlyFromReplayPrompts
          ? allReplayPrompts.filter((prompt) => Boolean(prompt.attachmentParts?.length))
          : allReplayPrompts;

        const normalizer = new AcpSessionReplayNormalizer({ antigravity: true });
        normalizer.beginProviderPromptReplay(replayPrompts);

        let clock = 1_700_100_000_000;
        for (const [index, turn] of turns.entries()) {
          const timestampField = turn.providerTimestamps
            ? { timestamp: clock + index * 1_000 }
            : {};
          if (turn.text) {
            normalizer.apply({
              sessionId: "sess-1",
              receivedAt: clock++,
              update: {
                sessionUpdate: "user_message_chunk",
                content: { type: "text", text: turn.text },
                ...timestampField,
              },
            });
          }
          for (const imageName of turn.images) {
            const annotation = turn.annotationStyle === "attached"
              ? `Attached image filename: ${imageName}`
              : `[Local image: ${imageName}]`;
            normalizer.apply({
              sessionId: "sess-1",
              receivedAt: clock++,
              update: {
                sessionUpdate: "user_message_chunk",
                content: { type: "text", text: annotation },
                ...timestampField,
              },
            });
            if (turn.providerReplaysImageBlock) {
              normalizer.apply({
                sessionId: "sess-1",
                receivedAt: clock++,
                update: {
                  sessionUpdate: "user_message_chunk",
                  content: { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
                  ...timestampField,
                },
              });
            }
          }
          normalizer.apply({
            sessionId: "sess-1",
            receivedAt: clock++,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `Reply ${index}` },
              ...timestampField,
            },
          });
        }
        normalizer.endProviderPromptReplay(undefined);

        const userMessages = normalizer.replay().messages.filter((m) => m.role === "user");
        expect(userMessages).toHaveLength(turns.length);
        for (const [index, turn] of turns.entries()) {
          const message = userMessages[index]!;
          expect(message.text).toBe(turn.text);
          const imageAlts = (message.parts ?? [])
            .filter((part) => part.type === "image")
            .map((part) => part.alt);
          expect(imageAlts).toEqual(turn.images);
        }
      }),
    );
  });

  it("folds provider-replayed image blocks and filename annotations without local rollout overlay", () => {
    const normalizer = new AcpSessionReplayNormalizer({ antigravity: true });
    normalizer.apply({
      sessionId: "sess-2",
      receivedAt: 1000,
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "Look at this" },
      },
    });
    normalizer.apply({
      sessionId: "sess-2",
      receivedAt: 1001,
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "Attached image filename: shot.png" },
      },
    });
    normalizer.apply({
      sessionId: "sess-2",
      receivedAt: 1002,
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
      },
    });

    const userMessages = normalizer.replay().messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.text).toBe("Look at this");
    expect(userMessages[0]?.parts).toEqual([
      { type: "text", text: "Look at this" },
      { type: "image", alt: "shot.png", url: "data:image/png;base64,iVBORw0KGgo=" },
    ]);
  });

  it("does not let an earlier text-only turn steal a later matching turn's image attachments", () => {
    const normalizer = new AcpSessionReplayNormalizer({ antigravity: false });
    normalizer.beginProviderPromptReplay([
      {
        turnId: "turn-2",
        receivedAt: 1_700_000_060_000,
        textDigest: acpReplayPromptTextDigest("Continue"),
        attachmentParts: [
          { type: "image", alt: "shot.png", url: "pwragent-image://file/%2Ftmp%2Fshot.png" },
        ],
      },
    ]);

    normalizer.apply({
      sessionId: "sess-steal",
      receivedAt: 1000,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Continue" } },
    });
    normalizer.apply({
      sessionId: "sess-steal",
      receivedAt: 1001,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "First answer" } },
    });
    normalizer.apply({
      sessionId: "sess-steal",
      receivedAt: 2000,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Continue" } },
    });
    normalizer.apply({
      sessionId: "sess-steal",
      receivedAt: 2001,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Attached image filename: shot.png" } },
    });
    normalizer.apply({
      sessionId: "sess-steal",
      receivedAt: 2002,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Second answer" } },
    });
    normalizer.endProviderPromptReplay(undefined);

    const userMessages = normalizer.replay().messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0]?.text).toBe("Continue");
    expect(userMessages[0]?.parts).toBeUndefined();
    expect(userMessages[1]?.text).toBe("Continue");
    expect(userMessages[1]?.parts).toEqual([
      { type: "text", text: "Continue" },
      { type: "image", alt: "shot.png", url: "pwragent-image://file/%2Ftmp%2Fshot.png" },
    ]);
  });

  it("ignores echoed provider user image chunks when the active turn already recorded the local prompt", () => {
    const normalizer = new AcpSessionReplayNormalizer();
    const localUrl = "pwragent-image://file/%2Ftmp%2Flocal.png";
    normalizer.recordUserPrompt({
      sessionId: "sess-echo",
      turnId: "turn-live",
      prompt: "Check this",
      parts: [
        { type: "text", text: "Check this" },
        { type: "image", alt: "local.png", url: localUrl },
      ],
      receivedAt: 1000,
      waitingForAgent: true,
    });
    normalizer.apply({
      sessionId: "sess-echo",
      receivedAt: 1001,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Check this" } },
    });
    normalizer.apply({
      sessionId: "sess-echo",
      receivedAt: 1002,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Attached image filename: local.png" } },
    });
    normalizer.apply({
      sessionId: "sess-echo",
      receivedAt: 1003,
      update: { sessionUpdate: "user_message_chunk", content: { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" } },
    });

    const userMessages = normalizer.replay().messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.parts).toEqual([
      { type: "text", text: "Check this" },
      { type: "image", alt: "local.png", url: localUrl },
    ]);
  });

  it("preserves multiple distinct replayed data: images that share the same filename", () => {
    const normalizer = new AcpSessionReplayNormalizer();
    normalizer.apply({
      sessionId: "sess-same-name",
      receivedAt: 1000,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Compare both" } },
    });
    normalizer.apply({
      sessionId: "sess-same-name",
      receivedAt: 1001,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Attached image filename: image.png" } },
    });
    normalizer.apply({
      sessionId: "sess-same-name",
      receivedAt: 1002,
      update: { sessionUpdate: "user_message_chunk", content: { type: "image", mimeType: "image/png", data: "AAAA" } },
    });
    normalizer.apply({
      sessionId: "sess-same-name",
      receivedAt: 1003,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Attached image filename: image.png" } },
    });
    normalizer.apply({
      sessionId: "sess-same-name",
      receivedAt: 1004,
      update: { sessionUpdate: "user_message_chunk", content: { type: "image", mimeType: "image/png", data: "BBBB" } },
    });

    const userMessages = normalizer.replay().messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.parts).toEqual([
      { type: "text", text: "Compare both" },
      { type: "image", alt: "image.png", url: "data:image/png;base64,AAAA" },
      { type: "image", alt: "image.png", url: "data:image/png;base64,BBBB" },
    ]);
  });
});
