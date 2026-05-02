import type {
  MessagingDeliveryResult,
  MessagingInboundEvent,
  MessagingSurfaceIntent,
} from "../index";
import { MESSAGING_SURFACE_INTENT_KINDS } from "../index";

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
});
