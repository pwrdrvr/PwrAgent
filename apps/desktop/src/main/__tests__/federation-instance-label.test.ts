import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  hostname: vi.fn(),
  platform: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFileSync: mocks.execFileSync }));
vi.mock("node:os", () => ({ hostname: mocks.hostname, platform: mocks.platform }));

describe("automatic federation instance label", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mocks.platform.mockReturnValue("darwin");
    mocks.hostname.mockReturnValue("ip-192-168-10-2.ec2.internal");
    mocks.execFileSync.mockReturnValue("Harold-MBP-M5-Max\n");
  });

  it("advertises the stable Mac name instead of a network-assigned hostname", async () => {
    const { defaultInstanceLabel } = await import("../federation/federation-instance-label");

    expect(defaultInstanceLabel()).toBe("Harold-MBP-M5-Max");
    expect(mocks.hostname).not.toHaveBeenCalled();
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      "/usr/sbin/scutil",
      ["--get", "LocalHostName"],
      expect.objectContaining({ timeout: 1_000 }),
    );
    // Health reads must not spawn another process each time they poll.
    expect(defaultInstanceLabel()).toBe("Harold-MBP-M5-Max");
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
  });

  it.each(["linux", "win32"])("keeps the hostname fallback on %s", async (platform) => {
    mocks.platform.mockReturnValue(platform);
    mocks.hostname.mockReturnValue("workstation.local");
    const { defaultInstanceLabel } = await import("../federation/federation-instance-label");

    expect(defaultInstanceLabel()).toBe("workstation");
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });

  it("falls back when the system-name lookup fails", async () => {
    mocks.execFileSync.mockImplementation(() => { throw new Error("unavailable"); });
    mocks.hostname.mockReturnValue("fallback.local");
    const { defaultInstanceLabel } = await import("../federation/federation-instance-label");

    expect(defaultInstanceLabel()).toBe("fallback");
    expect(defaultInstanceLabel()).toBe("fallback");
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
  });

  it("uses the application name when both system names are empty", async () => {
    mocks.execFileSync.mockReturnValue(" \n");
    mocks.hostname.mockReturnValue(" ");
    const { defaultInstanceLabel } = await import("../federation/federation-instance-label");

    expect(defaultInstanceLabel()).toBe("PwrAgent");
  });
});
