import type {
  MessagingDeliveryResult,
  MessagingInboundEvent,
  MessagingSurfaceIntent,
} from "../index";
import {
  MESSAGING_SURFACE_INTENT_KINDS,
  extractMessagingPairingToken,
  looksLikePairingAttempt,
} from "../index";

type FakeProvider = {
  deliver(intent: MessagingSurfaceIntent): Promise<MessagingDeliveryResult>;
  start(listener: (event: MessagingInboundEvent) => Promise<void>): Promise<void>;
};

describe("messaging interface package", () => {
  it("exports provider-facing contracts from a single entry point", async () => {
    const provider: FakeProvider = {
      async deliver(intent) {
        return {
          channel: intent.kind === "dismiss" ? intent.targetSurface.channel : "telegram",
          deliveredAt: 1000,
          outcome: "presented",
        };
      },
      async start(listener) {
        await listener({
          actor: {
            platformUserId: "user-1",
          },
          channel: {
            channel: "telegram",
            conversation: {
              id: "chat-1",
              kind: "dm",
            },
          },
          id: "event-1",
          kind: "text",
          receivedAt: 1000,
          text: "hello",
        });
      },
    };

    const seen: MessagingInboundEvent[] = [];
    await provider.start(async (event) => {
      seen.push(event);
    });

    await expect(
      provider.deliver({
        createdAt: 1000,
        id: "intent-1",
        kind: "message",
        parts: [
          {
            markdown: "plain",
            text: "hello",
            type: "text",
          },
        ],
      }),
    ).resolves.toMatchObject({
      channel: "telegram",
      outcome: "presented",
    });
    expect(seen).toMatchObject([
      {
        kind: "text",
        text: "hello",
      },
    ]);
    expect(MESSAGING_SURFACE_INTENT_KINDS).toContain("message");
    expect(MESSAGING_SURFACE_INTENT_KINDS).toContain("stream_update");
  });

  it("extracts pairing tokens from plain text, mention, and legacy forms", () => {
    const token = "123456789ABCDEFGHJKLMNPQRSTUVWXY";

    expect(extractMessagingPairingToken(`pair ${token}`)).toBe(token);
    expect(extractMessagingPairingToken(`@PwrAgentBot pair ${token}`)).toBe(token);
    expect(extractMessagingPairingToken(`please pair ${token}`)).toBe(token);
    expect(extractMessagingPairingToken(`pwragent_pair ${token}`)).toBe(token);
    expect(extractMessagingPairingToken(`/pair ${token}`)).toBe(token);
    expect(extractMessagingPairingToken(`/pwragent_pair ${token}`)).toBe(token);
  });

  it("treats Unicode whitespace between command and token as a separator", () => {
    // U+00A0 NO-BREAK SPACE — Telegram iOS / some clipboard pipelines
    // substitute this for a plain space when pasting. Before the
    // tokenizer learned to recognize Unicode whitespace, a paste like
    // this would tokenize as one big "pair <token>" blob and
    // `extractMessagingPairingToken` would return undefined — silently
    // dropping the operator's pairing attempt.
    const token = "123456789ABCDEFGHJKLMNPQRSTUVWXY";
    expect(extractMessagingPairingToken(`pair ${token}`)).toBe(token);
    expect(extractMessagingPairingToken(`pair ${token}`)).toBe(token);
    expect(extractMessagingPairingToken(`pair ${token}`)).toBe(token);
    expect(extractMessagingPairingToken(`pair　${token}`)).toBe(token);
  });

  it("looksLikePairingAttempt routes typo'd / malformed tokens through", () => {
    // Source of truth: the runtime's `handlePairingInbound` runs the
    // strict token validation, not the adapter. Adapters use this
    // looser predicate so a `pair <garbage>` typed in a fresh group
    // routes to the runtime (which replies with "That PwrAgent
    // pairing token is invalid or expired.") instead of being silently
    // dropped at the conversation-authorization check.
    expect(looksLikePairingAttempt("pair garbage")).toBe(true);
    expect(looksLikePairingAttempt("pair x")).toBe(true);
    expect(looksLikePairingAttempt("/pair anything")).toBe(true);
    expect(looksLikePairingAttempt("@PwrAgentBot pair anything")).toBe(true);
    expect(looksLikePairingAttempt("pwragent_pair anything")).toBe(true);
    // Negative cases: no pairing keyword, or keyword with no follow-up.
    expect(looksLikePairingAttempt("hello world")).toBe(false);
    expect(looksLikePairingAttempt("pair")).toBe(false);
    expect(looksLikePairingAttempt("")).toBe(false);
    // Mid-sentence "pair" followed by another word IS a false-positive
    // by design — we'd rather route an over-broad match to the runtime
    // (which replies with a friendly "invalid or expired" if it's not
    // a real pairing) than silently drop a real pairing attempt at the
    // adapter. Verifying the over-broad behavior so it isn't tightened
    // later without a conscious trade-off.
    expect(looksLikePairingAttempt("the word pair appears here")).toBe(true);
  });

  it("bounds pairing scans over untrusted message text", () => {
    const token = "123456789ABCDEFGHJKLMNPQRSTUVWXY";
    const largePayload = "x".repeat(1_000_000);

    expect(extractMessagingPairingToken(`pair ${token} ${largePayload}`)).toBe(token);
    expect(extractMessagingPairingToken(`${largePayload} pair ${token}`)).toBeUndefined();
    expect(extractMessagingPairingToken(`pair ${largePayload}`)).toBeUndefined();
  });

  it("does not throw on fuzzed pairing-like payloads", () => {
    let seed = 0x5eed;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed;
    };
    const alphabet = "pair/PWRAGENT_  \t\r\n'\";--0123456789ABCDEFGHJKLMNPQRSTUVWXYZxyz";

    for (let caseIndex = 0; caseIndex < 500; caseIndex += 1) {
      const length = next() % 2048;
      let payload = "";
      for (let index = 0; index < length; index += 1) {
        payload += alphabet[next() % alphabet.length];
      }
      expect(() => extractMessagingPairingToken(payload)).not.toThrow();
    }
  });
});
