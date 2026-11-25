import fc from "fast-check";
import { expect, it } from "vitest";
import { AcpSessionReplayNormalizer } from "../acp/acp-session-normalizer";

it("replays final ACP Markdown independently of its chunk boundaries", () => {
  const markdown = [
    "### Summary",
    "",
    "| Shape | Cold | Warm | Per turn | Watch |",
    "| --- | ---: | ---: | ---: | ---: |",
    "| Default | 28 | 24 | **12.0** | — |",
    "| Dormant | 26 | 32 | **14.0** | — |",
    "",
    "The **warm** results are stable.",
    "",
    "See [the guide](https://example.com/guide#details).",
  ].join("\n");
  const cuts = fc.uniqueArray(fc.integer({ min: 1, max: markdown.length - 1 }), {
    maxLength: markdown.length - 1,
    size: "max",
  });

  // ACP streams literal deltas. Joining all text is the same oracle the live
  // transcript and the disk buffer use, regardless of how they batch updates.
  fc.assert(fc.property(cuts, (offsets) => {
    const normalizer = new AcpSessionReplayNormalizer();
    const boundaries = [...offsets.sort((a, b) => a - b), markdown.length];
    let start = 0;
    for (const end of boundaries) {
      normalizer.apply({
        sessionId: "session-1",
        receivedAt: 1000 + start,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: markdown.slice(start, end) },
        },
      });
      start = end;
    }

    const replay = normalizer.replay();
    expect(replay.entries).toMatchObject([
      { type: "message", phase: "final", text: markdown },
    ]);
    expect(replay.messages).toMatchObject([
      { role: "assistant", text: markdown },
    ]);
  }));
});
