import { describe, expect, it, vi } from "vitest";
import { DiscordGateway } from "../messaging/discord-gateway";

describe("DiscordGateway", () => {
  it("opens a Discord Gateway socket and identifies after hello", async () => {
    vi.useFakeTimers();
    const sent: unknown[] = [];
    const socket = {
      close: vi.fn(),
      onclose: null as ((event: unknown) => void) | null,
      onerror: null as ((event: unknown) => void) | null,
      onmessage: null as ((event: { data: unknown }) => void) | null,
      onopen: null as (() => void) | null,
      send: vi.fn((data: string) => {
        sent.push(JSON.parse(data));
      }),
    };
    const websocketFactory = vi.fn(() => socket);
    const gateway = new DiscordGateway({
      botToken: "discord-token",
      gatewayUrl: "wss://gateway.example",
      websocketFactory,
    });

    await gateway.start();
    socket.onmessage?.({
      data: JSON.stringify({
        d: {
          heartbeat_interval: 1000,
        },
        op: 10,
      }),
    });
    vi.advanceTimersByTime(1000);

    expect(websocketFactory).toHaveBeenCalledWith("wss://gateway.example");
    expect(sent).toEqual([
      expect.objectContaining({
        d: expect.objectContaining({
          token: "discord-token",
        }),
        op: 2,
      }),
      {
        d: null,
        op: 1,
      },
    ]);

    await gateway.close();
    vi.useRealTimers();
  });

  it("dispatches gateway events to listeners and tracks sequence for heartbeats", async () => {
    vi.useFakeTimers();
    const sendHeartbeat = vi.fn();
    const listener = vi.fn();
    const gateway = new DiscordGateway({
      heartbeatIntervalMs: 1000,
      sendHeartbeat,
    });
    gateway.onEvent(listener);

    await gateway.start();
    await gateway.emitForTests({
      d: {
        author: {
          id: "42",
          username: "ada",
        },
        channel_id: "channel-1",
        content: "/threads",
        id: "message-1",
      },
      op: 0,
      s: 10,
      t: "MESSAGE_CREATE",
    });
    vi.advanceTimersByTime(1000);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(sendHeartbeat).toHaveBeenCalledWith(10);

    await gateway.close();
    vi.useRealTimers();
  });

  it("surfaces heartbeat misses to reconnect policy owners", async () => {
    const onHeartbeatMiss = vi.fn();
    const gateway = new DiscordGateway({
      onHeartbeatMiss,
    });

    await gateway.notifyHeartbeatMissForTests();

    expect(onHeartbeatMiss).toHaveBeenCalledTimes(1);
  });
});
