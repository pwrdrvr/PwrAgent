import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildProviderResponseBlockEntry,
  detectProviderResponseBlock,
  readProviderResponseBlockNotification,
} from "../provider-response-block";

// Codex's own wording for a Responses `response.incomplete` event (CodexErr
// display text), and the two TurnError shapes it reports it in. Only the
// `content_filter` reason is a provider block; every other incomplete reason
// is a different failure and must keep its ordinary handling.
const incomplete = (reason: string): string =>
  `stream disconnected before completion: Incomplete response returned, reason: ${reason}`;

const reasonArb = fc.oneof(
  fc.constantFrom(
    "content_filter",
    "max_output_tokens",
    "max_tokens",
    "content_filter_v2",
    "content_filtered",
  ),
  fc.stringMatching(/^[a-z_]{1,24}$/),
);

const errorArb = fc.oneof(
  fc.record({ reason: reasonArb, attempt: fc.nat(9), max: fc.integer({ min: 1, max: 9 }) }).map(
    ({ reason, attempt, max }) => ({
      kind: "retry" as const,
      reason,
      error: {
        message: `Reconnecting... ${attempt}/${max}`,
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
        additionalDetails: incomplete(reason),
        misalignment: null,
      },
    }),
  ),
  reasonArb.map((reason) => ({
    kind: "terminal" as const,
    reason,
    error: { message: incomplete(reason), codexErrorInfo: "other", additionalDetails: null },
  })),
  // The dedicated code proposed for the protocol; the text may then be gone.
  fc.string().map((message) => ({
    kind: "coded" as const,
    reason: "content_filter",
    error: { message, codexErrorInfo: "contentFilter" },
  })),
  fc.record({
    message: fc.string().filter((text) => !text.includes("content_filter")),
    info: fc.constantFrom("other", "serverOverloaded", "cyberPolicy", "usageLimitExceeded", null),
  }).map(({ message, info }) => ({
    kind: "unrelated" as const,
    reason: "none",
    error: { message, codexErrorInfo: info },
  })),
);

describe("detectProviderResponseBlock", () => {
  it("reports a block exactly when the provider ended the response for content_filter", () => {
    fc.assert(fc.property(errorArb, ({ reason, error }) => {
      expect(detectProviderResponseBlock(error))
        .toBe(reason === "content_filter" ? "contentFilter" : undefined);
    }));
  });

  it("gives a turn-ending error and its turn/failed one entry, apart from a recovered block", () => {
    fc.assert(fc.property(
      fc.stringMatching(/^[0-9a-f-]{8,36}$/),
      errorArb.filter(({ reason }) => reason === "content_filter"),
      (turnId, { error }) => {
        const final = readProviderResponseBlockNotification({
          method: "error",
          params: { threadId: "thread", turnId, willRetry: false, error },
        });
        const failed = readProviderResponseBlockNotification({
          method: "turn/failed",
          params: { threadId: "thread", turnId, turn: { id: turnId, status: "failed", error } },
        });
        const retry = readProviderResponseBlockNotification({
          method: "error",
          params: { threadId: "thread", turnId, willRetry: true, error },
        });
        expect(final?.turnEnded).toBe(true);
        expect(failed?.turnEnded).toBe(true);
        expect(retry?.turnEnded).toBe(false);
        const id = (signal: typeof final) => buildProviderResponseBlockEntry({ ...signal!, turnId })?.id;
        expect(id(final)).toBe(id(failed));
        expect(id(retry)).not.toBe(id(final));
      },
    ));
  });
});
