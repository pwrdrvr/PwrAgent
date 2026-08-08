import { describe, expect, it, vi } from "vitest";
import {
  checkGrokCliUpdate,
  GROK_UPDATE_FAILURE_TTL_MS,
  GROK_UPDATE_SUCCESS_TTL_MS,
  shouldCheckGrokCliUpdate,
} from "../acp/grok-cli-update";

describe("checkGrokCliUpdate", () => {
  it("normalizes the official JSON status and preserves same-version acknowledgement", async () => {
    const probe = vi.fn(async () => ({
      stdout: JSON.stringify({
        currentVersion: "0.2.118",
        latestVersion: "1.0.0",
        updateAvailable: true,
        installer: "npm",
        channel: "stable",
        autoUpdate: true,
        error: null,
      }),
    }));

    await expect(checkGrokCliUpdate("/opt/grok", {
      now: () => 500,
      previous: {
        status: "available",
        checkedAt: 100,
        currentVersion: "0.2.118",
        latestVersion: "1.0.0",
        snoozedUntil: 900,
      },
      probe,
    })).resolves.toEqual({
      status: "available",
      checkedAt: 500,
      currentVersion: "0.2.118",
      latestVersion: "1.0.0",
      installer: "npm",
      channel: "stable",
      autoUpdate: true,
      snoozedUntil: 900,
    });
    expect(probe).toHaveBeenCalledWith("/opt/grok");
  });

  it("clears acknowledgement for a new latest version", async () => {
    const update = await checkGrokCliUpdate("grok", {
      now: () => 500,
      previous: {
        status: "available",
        checkedAt: 100,
        currentVersion: "0.2.118",
        latestVersion: "0.2.119",
        dismissedAt: 200,
      },
      probe: async () => ({
        stdout: JSON.stringify({
          currentVersion: "0.2.118",
          latestVersion: "1.0.0",
          updateAvailable: true,
          channel: "stable",
          error: null,
        }),
      }),
    });

    expect(update.dismissedAt).toBeUndefined();
    expect(update.latestVersion).toBe("1.0.0");
  });

  it("keeps a known available update durable across an offline retry", async () => {
    await expect(checkGrokCliUpdate("grok", {
      now: () => 500,
      previous: {
        status: "available",
        checkedAt: 100,
        currentVersion: "0.2.118",
        latestVersion: "1.0.0",
      },
      probe: async () => ({ stdout: "not-json" }),
    })).resolves.toMatchObject({
      status: "available",
      checkedAt: 500,
      currentVersion: "0.2.118",
      latestVersion: "1.0.0",
      error: "Grok update check returned invalid JSON",
    });
  });

  it("turns an initial CLI failure into quiet retryable status", async () => {
    await expect(checkGrokCliUpdate("grok", {
      now: () => 500,
      installedVersion: "0.2.118",
      probe: async () => {
        throw new Error("offline");
      },
    })).resolves.toEqual({
      status: "failed",
      checkedAt: 500,
      currentVersion: "0.2.118",
      error: "offline",
    });
  });
});

describe("shouldCheckGrokCliUpdate", () => {
  const previous = {
    status: "up-to-date" as const,
    checkedAt: 100,
    currentVersion: "1.0.0",
  };

  it("rechecks on command or installed-version changes", () => {
    expect(shouldCheckGrokCliUpdate({
      command: "/new/grok",
      installedVersion: "1.0.0",
      now: 200,
      previous,
      previousCommand: "/old/grok",
    })).toBe(true);
    expect(shouldCheckGrokCliUpdate({
      command: "/grok",
      installedVersion: "1.0.1",
      now: 200,
      previous,
      previousCommand: "/grok",
    })).toBe(true);
  });

  it("uses a daily success cadence and hourly failure retry", () => {
    expect(shouldCheckGrokCliUpdate({
      command: "/grok",
      installedVersion: "1.0.0",
      now: 100 + GROK_UPDATE_SUCCESS_TTL_MS - 1,
      previous,
      previousCommand: "/grok",
    })).toBe(false);
    expect(shouldCheckGrokCliUpdate({
      command: "/grok",
      installedVersion: "1.0.0",
      now: 100 + GROK_UPDATE_SUCCESS_TTL_MS,
      previous,
      previousCommand: "/grok",
    })).toBe(true);
    expect(shouldCheckGrokCliUpdate({
      command: "/grok",
      now: 100 + GROK_UPDATE_FAILURE_TTL_MS,
      previous: { ...previous, status: "failed" },
      previousCommand: "/grok",
    })).toBe(true);
  });
});
