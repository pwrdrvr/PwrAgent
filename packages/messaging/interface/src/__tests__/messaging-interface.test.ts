import type {
  MessagingDeliveryResult,
  MessagingInboundEvent,
  MessagingSurfaceIntent,
} from "../index";
import {
  MESSAGING_SURFACE_INTENT_KINDS,
  extractMessagingPairingToken,
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
