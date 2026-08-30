import { describe, expect, it } from "vitest";
import {
  MACOS_CODE_MODE_HOST_JIT_ENTITLEMENTS,
  missingMacosCodeModeHostJitEntitlements,
} from "../managed-runtime-signature";

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
