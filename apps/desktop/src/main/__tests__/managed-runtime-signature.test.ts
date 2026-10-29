import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MACOS_CODE_MODE_HOST_JIT_ENTITLEMENTS,
  missingMacosCodeModeHostJitEntitlements,
  verifyMatchingPlatformSignature,
} from "../managed-runtime-signature";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return {
    execFile: Object.assign(vi.fn(), { [promisify.custom]: execFileMock }),
  };
});

describe("managed runtime Windows signature errors", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("accepts a successful Windows signature verification", async () => {
    execFileMock.mockResolvedValue({ stdout: "", stderr: "" });
    await expect(verifyMatchingPlatformSignature("runtime.exe", "application.exe", "win32"))
      .resolves.toBeUndefined();
  });

  it("reports the verification reason without the PowerShell command", async () => {
    const reason = "The managed runtime publisher does not match this PwrAgent build.";
    const failure = Object.assign(new Error("Command failed: powershell.exe -Command ..."), {
      stdout: `${reason}\r\n`,
    });
    execFileMock.mockRejectedValue(failure);
    await expect(verifyMatchingPlatformSignature("runtime.exe", "application.exe", "win32"))
      .rejects.toMatchObject({ message: reason, cause: failure });
  });

  it("rejects a verifier that cannot run with a concise error and retains its cause", async () => {
    const failure = new Error("spawn powershell.exe ENOENT");
    execFileMock.mockRejectedValue(failure);
    await expect(verifyMatchingPlatformSignature("runtime.exe", "application.exe", "win32"))
      .rejects.toMatchObject({
        message: "Windows could not verify the managed runtime signature.",
        cause: failure,
      });
  });
});

describe("managed runtime macOS entitlements", () => {
  it("accepts the codesign entitlement display used by current macOS", () => {
    expect(missingMacosCodeModeHostJitEntitlements(`
[Dict]
  [Key] com.apple.security.cs.allow-jit
  [Value]
    [Bool] true
  [Key] com.apple.security.cs.allow-unsigned-executable-memory
  [Value]
    [Bool] true
`)).toEqual([]);
  });

  it("accepts XML entitlement output", () => {
    expect(missingMacosCodeModeHostJitEntitlements(`
<plist version="1.0">
  <dict>
    <key>com.apple.security.cs.allow-jit</key><true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  </dict>
</plist>
`)).toEqual([]);
  });

  it("reports every absent or disabled JIT entitlement", () => {
    expect(missingMacosCodeModeHostJitEntitlements(`
[Dict]
  [Key] com.apple.security.cs.allow-jit
  [Value]
    [Bool] false
`)).toEqual([...MACOS_CODE_MODE_HOST_JIT_ENTITLEMENTS]);
  });
});
