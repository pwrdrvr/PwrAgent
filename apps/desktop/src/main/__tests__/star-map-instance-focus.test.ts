import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StarMapCommandResponse } from "@pwragent/shared";
import { sendStarMapCommand } from "../star-map/star-map-command-bus";
import {
  STAR_MAP_INSTANCE_FOCUS_TIMEOUT_MS,
  attemptStarMapInstanceFocus,
  requestStarMapInstanceFocus,
  resetStarMapInstanceFocus,
} from "../star-map/star-map-instance-focus";

vi.mock("../star-map/star-map-command-bus", () => ({
  sendStarMapCommand: vi.fn(),
}));

const map = (id = 9) => ({ id, isDestroyed: () => false }) as unknown as WebContents;
const notDrawn: StarMapCommandResponse = {
  ok: false,
  error: { code: "not_found", message: "Instance laptop is not on the map." },
};
const flown: StarMapCommandResponse = { ok: true, data: { target: "instance", label: "Laptop" } };

describe("Star Map instance focus", () => {
  beforeEach(() => {
    resetStarMapInstanceFocus();
    vi.mocked(sendStarMapCommand).mockReset();
  });
  afterEach(() => resetStarMapInstanceFocus());

  it("flies an already-drawn map straight away", async () => {
    vi.mocked(sendStarMapCommand).mockResolvedValue(flown);
    const contents = map();
    requestStarMapInstanceFocus({ webContents: contents, instanceId: "laptop", mapReady: true, now: 0 });
    expect(sendStarMapCommand).toHaveBeenCalledWith(
      { kind: "fly_to", target: { kind: "instance", instanceId: "laptop" } },
      expect.objectContaining({ webContents: expect.any(Function) }),
    );
    await vi.waitFor(() => expect(sendStarMapCommand).toHaveBeenCalledTimes(1));
    attemptStarMapInstanceFocus(contents, 10);
    expect(sendStarMapCommand).toHaveBeenCalledTimes(1);
  });

  it("waits for a new map to publish, and retries while the instance is not drawn yet", async () => {
    vi.mocked(sendStarMapCommand).mockResolvedValueOnce(notDrawn).mockResolvedValueOnce(flown);
    const contents = map();
    requestStarMapInstanceFocus({ webContents: contents, instanceId: "laptop", mapReady: false, now: 0 });
    expect(sendStarMapCommand).not.toHaveBeenCalled();
    attemptStarMapInstanceFocus(contents, 100);
    // A second publish while the first flight is out does not send another.
    attemptStarMapInstanceFocus(contents, 150);
    expect(sendStarMapCommand).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    attemptStarMapInstanceFocus(contents, 200);
    expect(sendStarMapCommand).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    await Promise.resolve();
    attemptStarMapInstanceFocus(contents, 300);
    expect(sendStarMapCommand).toHaveBeenCalledTimes(2);
  });

  it("ignores other windows and gives up after the timeout", () => {
    vi.mocked(sendStarMapCommand).mockResolvedValue(flown);
    const contents = map(9);
    requestStarMapInstanceFocus({ webContents: contents, instanceId: "laptop", mapReady: false, now: 0 });
    attemptStarMapInstanceFocus(map(10), 10);
    attemptStarMapInstanceFocus(contents, STAR_MAP_INSTANCE_FOCUS_TIMEOUT_MS + 1);
    attemptStarMapInstanceFocus(contents, 1);
    expect(sendStarMapCommand).not.toHaveBeenCalled();
  });
});
