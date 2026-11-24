import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildLiveToolDetails,
  getNotificationItem,
  mergeActivityDetails,
} from "../../renderer/src/features/thread-detail/live-transcript-activity";
import { AcpLiveToolUpdateResolver, acpToolUpdateNotifications } from "../acp/acp-live-notifications";
import { AcpSessionReplayNormalizer } from "../acp/acp-session-normalizer";

describe("ACP title-only scripts", () => {
  it.each(["sparse", "revised title", "explicit command"] as const)(
    "copies the latest script exactly in live and replay after a %s update",
    (completion) => {
      fc.assert(fc.property(
        fc.constantFrom("", "  ", "\t", "\n"),
        fc.constantFrom("\n", "\r\n"),
        fc.constantFrom("", "\\ ", "\n", "\n\n"),
        (prefix, newline, suffix) => {
          const opening = `${prefix}echo opening${newline}echo ready${suffix}`;
          const revised = `${prefix}echo revised${newline}echo done${suffix}`;
          const explicit = "echo explicit\necho done";
          const scripts = { sparse: opening, "revised title": revised, "explicit command": explicit };
          const expected = scripts[completion];
          const context = { backendId: "acp:gemini", threadId: "thread", turnId: "turn" };
          const resolver = new AcpLiveToolUpdateResolver();
          const normalizer = new AcpSessionReplayNormalizer();
          let liveDetails: ReturnType<typeof buildLiveToolDetails> = [];

          for (const update of [
            {
              sessionUpdate: "tool_call", toolCallId: "script", kind: "execute",
              title: opening, status: "in_progress",
            },
            {
              sessionUpdate: "tool_call_update", toolCallId: "script", status: "completed",
              ...(completion === "revised title" ? { title: revised } : {}),
              ...(completion === "explicit command" ? { rawInput: { command: explicit } } : {}),
              content: { type: "text", text: "finished" },
            },
          ]) {
            normalizer.apply({ sessionId: context.threadId, update });
            const resolved = resolver.resolve({ ...context, update });
            if (resolved) {
              for (const notification of acpToolUpdateNotifications({ ...context, update: resolved })) {
                if (notification.method === "item/started" || notification.method === "item/completed") {
                  const item = getNotificationItem(notification.params);
                  if (item) {
                    liveDetails = mergeActivityDetails(liveDetails, buildLiveToolDetails(item));
                  }
                }
              }
            }
          }

          const replay = normalizer.replay().entries.find((entry) => entry.type === "activity");
          const liveCommand = liveDetails[0]?.command;
          const replayCommand = replay?.details[0]?.command;

          // The provider's latest explicit script is the copyable text in both paths.
          expect(liveCommand?.rawCommand ?? liveCommand?.displayCommand).toBe(expected);
          expect(replayCommand?.rawCommand ?? replayCommand?.displayCommand).toBe(expected);
          expect(replayCommand?.displayCommand).toBe(liveCommand?.displayCommand);
          expect(liveCommand?.output).toBe("finished");
          expect(replayCommand?.output).toBe(liveCommand?.output);
          expect(replay?.details[0]?.label).toBe(liveDetails[0]?.label);
        },
      ));
    },
  );
});
