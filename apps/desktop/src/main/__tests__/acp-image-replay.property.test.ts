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

  it("does not duplicate a legacy data: overlay image when provider also replays the image block", () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    const normalizer = new AcpSessionReplayNormalizer({ antigravity: true });
    normalizer.beginProviderPromptReplay([
      {
        turnId: "turn-legacy",
        receivedAt: 1000,
        textDigest: acpReplayPromptTextDigest("Fix rate limits"),
        attachmentParts: [{ type: "image", alt: "shot.png", url: dataUrl }],
      },
    ]);
    normalizer.apply({
      sessionId: "sess-legacy-dedup",
      receivedAt: 2000,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Fix rate limits" } },
    });
    normalizer.apply({
      sessionId: "sess-legacy-dedup",
      receivedAt: 2001,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Attached image filename: shot.png" } },
    });
    normalizer.apply({
      sessionId: "sess-legacy-dedup",
      receivedAt: 2002,
      update: { sessionUpdate: "user_message_chunk", content: { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" } },
    });
    normalizer.endProviderPromptReplay(undefined);

    const userMessages = normalizer.replay().messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.parts).toEqual([
      { type: "text", text: "Fix rate limits" },
      { type: "image", alt: "shot.png", url: dataUrl },
    ]);
  });

  it("strips synthetic image annotations joined with user text in a single user_message_chunk", () => {
    const imageUrl = "pwragent-image://file/%2Ftmp%2Fjoined.png";
    const normalizer = new AcpSessionReplayNormalizer({ antigravity: true });
    normalizer.beginProviderPromptReplay([
      {
        turnId: "turn-joined",
        receivedAt: 1000,
        textDigest: acpReplayPromptTextDigest("Look here"),
        attachmentParts: [{ type: "image", alt: "joined.png", url: imageUrl }],
      },
    ]);
    normalizer.apply({
      sessionId: "sess-joined",
      receivedAt: 2000,
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "Look here\n[Local image: joined.png]" },
      },
    });
    normalizer.endProviderPromptReplay(undefined);

    const userMessages = normalizer.replay().messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.text).toBe("Look here");
    expect(userMessages[0]?.parts).toEqual([
      { type: "text", text: "Look here" },
      { type: "image", alt: "joined.png", url: imageUrl },
    ]);
  });

  it("matches prompts whose saved text had managed review context and does not stall later unnamed images", () => {
    const reviewContext =
      "[PwrAgent review sub-agent results — context for this turn]\n\n{\"findings\":[]}\n\n[End PwrAgent review sub-agent results]\nAuto-fix the findings";
    const unnamedUrl = "pwragent-image://file/%2Ftmp%2Funnamed.png";
    const normalizer = new AcpSessionReplayNormalizer({ antigravity: true });
    normalizer.beginProviderPromptReplay([
      {
        turnId: "turn-review",
        receivedAt: 1000,
        textDigest: acpReplayPromptTextDigest(reviewContext),
      },
      {
        turnId: "turn-unnamed",
        receivedAt: 2000,
        textDigest: acpReplayPromptTextDigest("Look at this paste"),
        attachmentParts: [{ type: "image", url: unnamedUrl }],
      },
    ]);
    normalizer.apply({
      sessionId: "sess-review-unnamed",
      receivedAt: 3000,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: reviewContext } },
    });
    normalizer.apply({
      sessionId: "sess-review-unnamed",
      receivedAt: 3001,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } },
    });
    normalizer.apply({
      sessionId: "sess-review-unnamed",
      receivedAt: 3002,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Look at this paste" } },
    });
    normalizer.endProviderPromptReplay(undefined);

    const userMessages = normalizer.replay().messages.filter((m) => m.role === "user");
    expect(userMessages.map((m) => m.text)).toEqual(["Auto-fix the findings", "Look at this paste"]);
    expect(userMessages[1]?.parts).toEqual([
      { type: "text", text: "Look at this paste" },
      { type: "image", url: unnamedUrl },
    ]);
  });

  it("folds consecutive multi-block text chunks belonging to one prompt and attaches its images", () => {
    const imageUrl = "pwragent-image://file/%2Ftmp%2Fmulti.png";
    const normalizer = new AcpSessionReplayNormalizer({ antigravity: true });
    normalizer.beginProviderPromptReplay([
      {
        turnId: "turn-multi",
        receivedAt: 1000,
        textDigest: acpReplayPromptTextDigest("First paragraph\nSecond paragraph"),
        attachmentParts: [{ type: "image", alt: "multi.png", url: imageUrl }],
      },
    ]);
    normalizer.apply({
      sessionId: "sess-multi",
      receivedAt: 2000,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "First paragraph" } },
    });
    normalizer.apply({
      sessionId: "sess-multi",
      receivedAt: 2001,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Second paragraph" } },
    });
    normalizer.apply({
      sessionId: "sess-multi",
      receivedAt: 2002,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Attached image filename: multi.png" } },
    });
    normalizer.endProviderPromptReplay(undefined);

    const userMessages = normalizer.replay().messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.text).toBe("First paragraph\nSecond paragraph");
    expect(userMessages[0]?.parts).toEqual([
      { type: "text", text: "First paragraph\nSecond paragraph" },
      { type: "image", alt: "multi.png", url: imageUrl },
    ]);
  });

  it("preserves consecutive image-only turns sharing the same filename without swallowing the second", () => {
    const img1 = "pwragent-image://file/%2Ftmp%2F1-image.png";
    const img2 = "pwragent-image://file/%2Ftmp%2F2-image.png";
    const normalizer = new AcpSessionReplayNormalizer({ antigravity: true });
    normalizer.beginProviderPromptReplay([
      {
        turnId: "turn-1",
        receivedAt: 1000,
        textDigest: acpReplayPromptTextDigest(""),
        attachmentParts: [{ type: "image", alt: "image.png", url: img1 }],
      },
      {
        turnId: "turn-1",
        steerMessageId: "user:turn-1:steer:1",
        receivedAt: 2000,
        textDigest: acpReplayPromptTextDigest(""),
        attachmentParts: [{ type: "image", alt: "image.png", url: img2 }],
      },
    ]);
    normalizer.apply({
      sessionId: "sess-consec-img",
      receivedAt: 3000,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "[Local image: image.png]" } },
    });
    normalizer.apply({
      sessionId: "sess-consec-img",
      receivedAt: 3001,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "[Local image: image.png]" } },
    });
    normalizer.endProviderPromptReplay(undefined);

    const userMessages = normalizer.replay().messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0]?.parts).toEqual([{ type: "image", alt: "image.png", url: img1 }]);
    expect(userMessages[1]?.parts).toEqual([{ type: "image", alt: "image.png", url: img2 }]);
  });

  it("preserves repeated user prompts and their images when session/load stamps all chunks with the same reload timestamp", () => {
    const img1 = "pwragent-image://file/%2Ftmp%2Ffirst-check.png";
    const img2 = "pwragent-image://file/%2Ftmp%2Fsecond-check.png";
    const reloadTs = 1_795_703_298_000;
    const normalizer = new AcpSessionReplayNormalizer({ antigravity: true });
    normalizer.beginProviderPromptReplay([
      {
        turnId: "turn-1",
        receivedAt: 1_795_700_000_000,
        textDigest: acpReplayPromptTextDigest("Check this"),
        attachmentParts: [{ type: "image", alt: "shot.png", url: img1 }],
      },
      {
        turnId: "turn-2",
        receivedAt: 1_795_700_060_000,
        textDigest: acpReplayPromptTextDigest("Check this"),
        attachmentParts: [{ type: "image", alt: "shot.png", url: img2 }],
      },
    ]);
    for (const reply of ["Reply 1", "Reply 2"]) {
      normalizer.apply({
        sessionId: "sess-reload-ts",
        receivedAt: reloadTs,
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Check this" }, timestamp: reloadTs },
      });
      normalizer.apply({
        sessionId: "sess-reload-ts",
        receivedAt: reloadTs,
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "[Local image: shot.png]" }, timestamp: reloadTs },
      });
      normalizer.apply({
        sessionId: "sess-reload-ts",
        receivedAt: reloadTs,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply }, timestamp: reloadTs },
      });
    }
    normalizer.endProviderPromptReplay(reloadTs);

    const userMessages = normalizer.replay().messages.filter((m) => m.role === "user");
    expect(userMessages.map((m) => m.text)).toEqual(["Check this", "Check this"]);
    expect(userMessages[0]?.parts).toEqual([
      { type: "text", text: "Check this" },
      { type: "image", alt: "shot.png", url: img1 },
    ]);
    expect(userMessages[1]?.parts).toEqual([
      { type: "text", text: "Check this" },
      { type: "image", alt: "shot.png", url: img2 },
    ]);
  });

  it("does not let an earlier text-only turn steal a later mixed named+unnamed image turn", () => {
    const namedUrl = "pwragent-image://file/%2Ftmp%2Fnamed.png";
    const unnamedUrl = "pwragent-image://file/%2Ftmp%2Funnamed.png";
    const normalizer = new AcpSessionReplayNormalizer({ antigravity: false });
    normalizer.beginProviderPromptReplay([
      {
        turnId: "turn-2",
        receivedAt: 1_700_000_060_000,
        textDigest: acpReplayPromptTextDigest("Continue"),
        attachmentParts: [
          { type: "image", alt: "named.png", url: namedUrl },
          { type: "image", url: unnamedUrl },
        ],
      },
    ]);
    normalizer.apply({
      sessionId: "sess-mixed-steal",
      receivedAt: 1000,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Continue" } },
    });
    normalizer.apply({
      sessionId: "sess-mixed-steal",
      receivedAt: 1001,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "First reply" } },
    });
    normalizer.apply({
      sessionId: "sess-mixed-steal",
      receivedAt: 2000,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Continue" } },
    });
    normalizer.apply({
      sessionId: "sess-mixed-steal",
      receivedAt: 2001,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "[Local image: named.png]" } },
    });
    normalizer.apply({
      sessionId: "sess-mixed-steal",
      receivedAt: 2002,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Second reply" } },
    });
    normalizer.endProviderPromptReplay(undefined);

    const userMessages = normalizer.replay().messages.filter((m) => m.role === "user");
    expect(userMessages.map((m) => m.text)).toEqual(["Continue", "Continue"]);
    expect(userMessages[0]?.parts).toBeUndefined();
    expect(userMessages[1]?.parts).toEqual([
      { type: "text", text: "Continue" },
      { type: "image", alt: "named.png", url: namedUrl },
      { type: "image", url: unnamedUrl },
    ]);
  });

  it("preserves images across joined/separate chunks, legacy data: overlays, and timestamp modes", () => {
    const safeWord = fc.constantFrom("Continue", "Check this", "Fix rate limits");
    const safeFile = fc.constantFrom("image.png", "shot.png", "diagram.png");
    const turnGen = fc.record({
      text: fc.option(safeWord, { nil: "" }),
      images: fc.array(safeFile, { minLength: 0, maxLength: 2 }),
      annotationStyle: fc.constantFrom("attached" as const, "local" as const),
      joined: fc.boolean(),
      legacyDataOverlay: fc.boolean(),
      providerReplaysImageBlock: fc.boolean(),
    }).filter((t) => t.text.length > 0 || t.images.length > 0);

    fc.assert(
      fc.property(fc.array(turnGen, { minLength: 1, maxLength: 4 }), (turns) => {
        const replayPrompts: AcpReplayPromptIdentity[] = turns.map((turn, idx) => ({
          turnId: `turn-${idx}`,
          receivedAt: 1_700_000_000_000 + idx * 60_000,
          textDigest: acpReplayPromptTextDigest(turn.text),
          ...(turn.images.length > 0
            ? {
                attachmentParts: turn.images.map((name, imgIdx): AppServerThreadMessagePart => ({
                  type: "image",
                  alt: name,
                  url: turn.legacyDataOverlay
                    ? `data:image/png;base64,iVBORw0KGgo=${idx}${imgIdx}`
                    : `pwragent-image://file/%2Ftmp%2F${idx}-${imgIdx}-${encodeURIComponent(name)}`,
                })),
              }
            : {}),
        }));

        const normalizer = new AcpSessionReplayNormalizer({ antigravity: true });
        normalizer.beginProviderPromptReplay(replayPrompts);
        let clock = 1_700_200_000_000;
        for (const [idx, turn] of turns.entries()) {
          const lines: string[] = [];
          if (turn.text) lines.push(turn.text);
          for (const img of turn.images) {
            lines.push(
              turn.annotationStyle === "attached"
                ? `Attached image filename: ${img}`
                : `[Local image: ${img}]`,
            );
          }
          if (turn.joined) {
            normalizer.apply({
              sessionId: "sess-prop",
              receivedAt: clock++,
              update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: lines.join("\n") } },
            });
            if (turn.providerReplaysImageBlock) {
              for (let imgIdx = 0; imgIdx < turn.images.length; imgIdx += 1) {
                normalizer.apply({
                  sessionId: "sess-prop",
                  receivedAt: clock++,
                  update: {
                    sessionUpdate: "user_message_chunk",
                    content: { type: "image", mimeType: "image/png", data: `iVBORw0KGgo=${idx}${imgIdx}` },
                  },
                });
              }
            }
          } else {
            if (turn.text) {
              normalizer.apply({
                sessionId: "sess-prop",
                receivedAt: clock++,
                update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: turn.text } },
              });
            }
            for (const [imgIdx, img] of turn.images.entries()) {
              normalizer.apply({
                sessionId: "sess-prop",
                receivedAt: clock++,
                update: {
                  sessionUpdate: "user_message_chunk",
                  content: {
                    type: "text",
                    text: turn.annotationStyle === "attached"
                      ? `Attached image filename: ${img}`
                      : `[Local image: ${img}]`,
                  },
                },
              });
              if (turn.providerReplaysImageBlock) {
                normalizer.apply({
                  sessionId: "sess-prop",
                  receivedAt: clock++,
                  update: {
                    sessionUpdate: "user_message_chunk",
                    content: { type: "image", mimeType: "image/png", data: `iVBORw0KGgo=${idx}${imgIdx}` },
                  },
                });
              }
            }
          }
          normalizer.apply({
            sessionId: "sess-prop",
            receivedAt: clock++,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Reply ${idx}` } },
          });
        }
        normalizer.endProviderPromptReplay(undefined);

        const userMessages = normalizer.replay().messages.filter((m) => m.role === "user");
        expect(userMessages).toHaveLength(turns.length);
        for (const [idx, turn] of turns.entries()) {
          expect(userMessages[idx]?.text).toBe(turn.text);
          const imageAlts = (userMessages[idx]?.parts ?? [])
            .filter((part) => part.type === "image")
            .map((part) => part.alt);
          expect(imageAlts).toEqual(turn.images);
        }
      }),
    );
  });
});
