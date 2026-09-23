// Commands an Agent tool sends the Star Map, and the one answer each gets.
//
// The property worth pinning is that a turn is never left holding an open
// tool call: every command resolves, whether the map answers, closes, or
// says nothing at all - and only the map it went to can answer it.
import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StarMapCommand } from "@pwragent/shared";
import { STAR_MAP_COMMAND_CHANNEL } from "../../shared/ipc";
import {
  resetStarMapCommandBus,
  resolveStarMapCommand,
  sendStarMapCommand,
} from "../star-map/star-map-command-bus";

type FakeMap = WebContents & {
  send: ReturnType<typeof vi.fn>;
  destroy: () => void;
};

function fakeMap(id: number): FakeMap {
  const emitter = new EventEmitter();
  let destroyed = false;
  return Object.assign(emitter, {
    id,
    send: vi.fn(),
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
      emitter.emit("destroyed");
    },
  }) as unknown as FakeMap;
}

const flight = {
  kind: "fly_to" as const,
  target: { kind: "instance" as const, instanceId: "pwr_studio" },
};
const landed = {
  ok: true as const,
  data: { target: "instance" as const, label: "Studio" },
};

afterEach(() => {
  resetStarMapCommandBus();
  vi.useRealTimers();
});

describe("star map command bus", () => {
  it("resolves nothing when no map is open", async () => {
    await expect(
      sendStarMapCommand(flight, { webContents: () => undefined }),
    ).resolves.toBeUndefined();
  });

  it("delivers the map's answer to the command it sent", async () => {
    const map = fakeMap(7);
    const pending = sendStarMapCommand(flight, {
      webContents: () => map,
      newRequestId: () => "request-1",
    });

    expect(map.send).toHaveBeenCalledWith(STAR_MAP_COMMAND_CHANNEL, {
      ...flight,
      requestId: "request-1",
    } satisfies StarMapCommand);
    expect(
      resolveStarMapCommand({
        senderId: 7,
        result: { requestId: "request-1", response: landed },
      }),
    ).toBe(true);
    await expect(pending).resolves.toEqual(landed);
    // Answered is answered: a late duplicate must not reach anyone.
    expect(
      resolveStarMapCommand({
        senderId: 7,
        result: { requestId: "request-1", response: landed },
      }),
    ).toBe(false);
  });

  it("takes an answer only from the map the command went to", async () => {
    vi.useFakeTimers();
    const map = fakeMap(7);
    const pending = sendStarMapCommand(flight, {
      webContents: () => map,
      newRequestId: () => "request-1",
      timeoutMs: 1_000,
    });

    // Another map window knows nothing about this camera.
    expect(
      resolveStarMapCommand({
        senderId: 8,
        result: { requestId: "request-1", response: landed },
      }),
    ).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "internal_error" },
    });
  });

  it("says the map closed when it closes mid-command", async () => {
    const map = fakeMap(7);
    const pending = sendStarMapCommand(flight, { webContents: () => map });

    map.destroy();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "star_map_not_open" },
    });
  });
});
