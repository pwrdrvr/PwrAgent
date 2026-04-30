import { describe, expect, it, vi } from "vitest";
import { DiscordGateway } from "../messaging/discord-gateway";

describe("DiscordGateway", () => {
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
