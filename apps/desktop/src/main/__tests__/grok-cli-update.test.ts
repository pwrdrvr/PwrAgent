import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  checkGrokCliUpdate,
  GROK_UPDATE_FAILURE_TTL_MS,
  GROK_UPDATE_SUCCESS_TTL_MS,
  grokUpdateChecksDisabled,
  isPwrAgentOwnedGrokRuntime,
  shouldCheckGrokCliUpdate,
} from "../acp/grok-cli-update";
import { resolvePwragentRoot } from "../profile";

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

describe("grokUpdateChecksDisabled", () => {
  // Regression: on 2026-09-01 the docs-site capture run shipped the durable
  // "Grok update available" toast into 8 of 21 PNGs, because the vendor check
  // ran against the host's installed Grok. Unpackaged E2E must not arm it.
  it("disables the check for an unpackaged E2E launch", () => {
    expect(grokUpdateChecksDisabled({
      isPackaged: false,
      env: { PWRAGENT_E2E: "1" },
    })).toBe(true);
  });

  it("leaves the check armed for a packaged build, E2E flag or not", () => {
    expect(grokUpdateChecksDisabled({
      isPackaged: true,
      env: { PWRAGENT_E2E: "1" },
    })).toBe(false);
    expect(grokUpdateChecksDisabled({
      isPackaged: true,
      env: {},
    })).toBe(false);
  });

  it("leaves the check armed for an ordinary unpackaged dev run", () => {
    expect(grokUpdateChecksDisabled({
      isPackaged: false,
      env: {},
    })).toBe(false);
    // Only the exact "1" opts out, matching auto-updater.ts.
    expect(grokUpdateChecksDisabled({
      isPackaged: false,
      env: { PWRAGENT_E2E: "0" },
    })).toBe(false);
  });

  // The production caller — acp-backend-adapter.ts — omits `env`, so the
  // `?? process.env` default is the only branch that actually ships. Every
  // assertion above passes `env` inline and would stay green if that
  // default were changed to `{}`, which would silently re-arm the check
  // and put the toast back into the next capture run.
  it("falls back to process.env when no env is supplied", () => {
    vi.stubEnv("PWRAGENT_E2E", "1");
    expect(grokUpdateChecksDisabled({ isPackaged: false })).toBe(true);
    expect(grokUpdateChecksDisabled({ isPackaged: true })).toBe(false);

    vi.stubEnv("PWRAGENT_E2E", "");
    expect(grokUpdateChecksDisabled({ isPackaged: false })).toBe(false);

    vi.unstubAllEnvs();
  });
});

describe("isPwrAgentOwnedGrokRuntime", () => {
  const managedCommand = (tag: string) => path.join(
    resolvePwragentRoot(),
    "agents",
    "grok",
    "versions",
    tag,
    "grok",
  );

  it("trusts the discovery stamp", () => {
    expect(isPwrAgentOwnedGrokRuntime({
      launchDescriptor: {
        command: "/Users/me/.grok/bin/grok",
        args: [],
        env: { GROK_INSTALLER: "pwragent" },
      },
    } as never)).toBe(true);
  });

  it("claims a managed build the stamp missed", () => {
    // Discovery stamps by comparing against the command this run's release
    // check resolved, so a pinned older version, or any version present while
    // a check failed, arrives unstamped. It is still ours, and running the
    // vendor updater against it is what produced an xAI version number next to
    // a `-pwragent` build in the update toast.
    expect(isPwrAgentOwnedGrokRuntime({
      activeCommand: managedCommand("pwragent-v1.0.0-pwragent.1"),
      launchDescriptor: {
        command: managedCommand("pwragent-v1.0.0-pwragent.1"),
        args: [],
        env: {},
      },
    } as never)).toBe(true);
  });

  it("leaves an unstamped vendor install on the vendor channel", () => {
    expect(isPwrAgentOwnedGrokRuntime({
      activeCommand: "/Users/me/.grok/bin/grok",
      launchDescriptor: {
        command: "/Users/me/.grok/bin/grok",
        args: [],
        env: {},
      },
    } as never)).toBe(false);
    expect(isPwrAgentOwnedGrokRuntime({} as never)).toBe(false);
  });
});
