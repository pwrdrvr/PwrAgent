import { describe, expect, it } from "vitest";
import type { DesktopBootInfo } from "@pwragent/shared";
import { bootstrapProvisionProfileName } from "../OnboardingWizard";

/**
 * Regression guard for the "wizard re-fires forever under PWRAGENT_PROFILE=test"
 * bug. The single-profile bootstrap finish paths (Shared mode + "Skip and use
 * default") used to hardcode `default` as the provisioned profile name. But
 * boot resolves the pinned env/CLI name FIRST (before the registry default), so
 * provisioning `default` meant the next boot looked for `test`, didn't find it,
 * and showed the wizard again — every launch. The provisioned name must equal
 * the requested name whenever one was pinned.
 */
describe("bootstrapProvisionProfileName", () => {
  it("provisions the boot-requested profile name (the re-fire bug)", () => {
    const bootInfo: DesktopBootInfo = {
      mode: "bootstrap",
      decisionKind: "missing-named-profile",
      requestedProfileName: "test",
    };
    // MUST be "test", not "default" — otherwise the next boot with
    // PWRAGENT_PROFILE=test re-fires the wizard forever.
    expect(bootstrapProvisionProfileName(bootInfo)).toBe("test");
  });

  it("trims surrounding whitespace on the requested name", () => {
    const bootInfo: DesktopBootInfo = {
      mode: "bootstrap",
      decisionKind: "missing-named-profile",
      requestedProfileName: "  test  ",
    };
    expect(bootstrapProvisionProfileName(bootInfo)).toBe("test");
  });

  it("falls back to 'default' for an unnamed first run", () => {
    const bootInfo: DesktopBootInfo = {
      mode: "bootstrap",
      decisionKind: "no-profile-configured",
    };
    expect(bootstrapProvisionProfileName(bootInfo)).toBe("default");
  });

  it("falls back to 'default' when no boot info is available", () => {
    expect(bootstrapProvisionProfileName(null)).toBe("default");
  });

  it("ignores a stray requestedProfileName outside the missing-named-profile decision", () => {
    // requestedProfileName is only meaningful for missing-named-profile; a
    // value carried on any other decision kind must not steer provisioning.
    const bootInfo = {
      mode: "bootstrap",
      decisionKind: "no-profile-configured",
      requestedProfileName: "stray",
    } as DesktopBootInfo;
    expect(bootstrapProvisionProfileName(bootInfo)).toBe("default");
  });
});
