import { describe, expect, it, vi } from "vitest";
import type { AcpAgentSettingsEntry } from "@pwragent/shared";
import {
  buildManagedGrokBuildNotice,
  buildXaiGrokCliUpdateNotice,
} from "../GrokCliUpdateNotice";
import { XAI_GROK_UPDATE_URL } from "../../../lib/grok-build-channel";

function grokEntry(
  update: AcpAgentSettingsEntry["update"],
  overrides?: Partial<AcpAgentSettingsEntry>,
): AcpAgentSettingsEntry {
  return {
    backendId: "acp:grok",
    registryId: "grok",
    name: "Grok",
    authors: ["xAI"],
    distributionKind: "local",
    distributionSource: "grok agent stdio",
    installable: false,
    installed: true,
    installStatus: "installed",
    authStatus: "not-required",
    verificationStatus: "not-applicable",
    update,
    ...overrides,
  };
}

describe("buildXaiGrokCliUpdateNotice", () => {
  it("builds a version-keyed durable update notice", () => {
    const onOpenUpdatePage = vi.fn();
    const onDismiss = vi.fn();
    const notice = buildXaiGrokCliUpdateNotice({
      entry: grokEntry({
        status: "available",
        checkedAt: 100,
        currentVersion: "0.2.118",
        latestVersion: "1.0.0",
      }),
      now: 200,
      onOpenUpdatePage,
      onDismiss,
      onSnooze: vi.fn(),
    });

    expect(notice).toMatchObject({
      id: "acp-update:acp:grok:1.0.0",
      autoDismiss: false,
      title: "xAI Grok CLI update available",
      message: "xAI Grok 1.0.0 is available; your xAI install is 0.2.118.",
      detail:
        "PwrAgent does not update this build. Update it from x.ai/build, then"
        + " restart active Grok sessions.",
    });
    notice?.actions?.[0]?.onClick();
    expect(onOpenUpdatePage).toHaveBeenCalledWith(XAI_GROK_UPDATE_URL);
    notice?.onDismiss?.();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("hides dismissed, snoozed, current, and failed checks", () => {
    const callbacks = {
      onOpenUpdatePage: vi.fn(),
      onDismiss: vi.fn(),
      onSnooze: vi.fn(),
    };
    const available = {
      status: "available" as const,
      checkedAt: 100,
      currentVersion: "0.2.118",
      latestVersion: "1.0.0",
    };
    expect(buildXaiGrokCliUpdateNotice({
      entry: grokEntry({ ...available, dismissedAt: 150 }),
      now: 200,
      ...callbacks,
    })).toBeUndefined();
    expect(buildXaiGrokCliUpdateNotice({
      entry: grokEntry({ ...available, snoozedUntil: 300 }),
      now: 200,
      ...callbacks,
    })).toBeUndefined();
    expect(buildXaiGrokCliUpdateNotice({
      entry: grokEntry({ ...available, snoozedUntil: 199 }),
      now: 200,
      ...callbacks,
    })).toBeDefined();
    expect(buildXaiGrokCliUpdateNotice({
      entry: grokEntry({ ...available, status: "up-to-date" }),
      now: 200,
      ...callbacks,
    })).toBeUndefined();
    expect(buildXaiGrokCliUpdateNotice({
      entry: grokEntry({ ...available, status: "failed" }),
      now: 200,
      ...callbacks,
    })).toBeUndefined();
  });

  it("hides a vendor update status on a PwrAgent-supplied runtime", () => {
    const callbacks = {
      onOpenUpdatePage: vi.fn(),
      onDismiss: vi.fn(),
      onSnooze: vi.fn(),
    };
    const available = {
      status: "available" as const,
      checkedAt: 100,
      currentVersion: "1.0.3",
      latestVersion: "1.0.5",
    };

    expect(buildXaiGrokCliUpdateNotice({
      entry: grokEntry(available, {
        pwrAgentManagedRuntime: true,
        version: "1.0.4-pwragent.2",
      }),
      now: 200,
      ...callbacks,
    })).toBeUndefined();
    // A status left over from a vendor binary that is no longer the runtime:
    // the notice is durable, so a stale one would never clear itself.
    expect(buildXaiGrokCliUpdateNotice({
      entry: grokEntry(available, { version: "1.0.4-pwragent.2" }),
      now: 200,
      ...callbacks,
    })).toBeUndefined();
    expect(buildXaiGrokCliUpdateNotice({
      entry: grokEntry(available, { version: "1.0.3" }),
      now: 200,
      ...callbacks,
    })).toBeDefined();
  });
});

describe("buildManagedGrokBuildNotice", () => {
  const managed = {
    repository: "pwrdrvr/grok-build",
    installedTag: "pwragent-v1.0.5-pwragent.1",
    activeTag: "pwragent-v1.0.4-pwragent.2",
    checkedAt: 100,
    installedAt: 100,
    pinnedBehind: true,
  };

  it("names the PwrAgent channel and links its own release page", () => {
    const onOpenReleasePage = vi.fn();
    const notice = buildManagedGrokBuildNotice({
      entry: grokEntry(undefined, {
        managedBuild: managed,
        pwrAgentManagedRuntime: true,
        version: "1.0.4-pwragent.2",
      }),
      onOpenReleasePage,
    });

    expect(notice).toMatchObject({
      id: "managed-grok-build:pwragent-v1.0.5-pwragent.1",
      autoDismiss: false,
      title: "PwrAgent Grok build update not in use",
    });
    expect(notice?.message).toContain("pwragent-v1.0.5-pwragent.1");
    expect(notice?.message).toContain("pwragent-v1.0.4-pwragent.2");
    // Never the vendor's download page: this build does not come from there.
    expect(notice?.message).not.toContain("x.ai");
    notice?.actions?.[0]?.onClick();
    expect(onOpenReleasePage).toHaveBeenCalledWith(
      "https://github.com/pwrdrvr/grok-build/releases/tag/pwragent-v1.0.5-pwragent.1",
    );
  });

  it("stays silent when the channel can resolve itself", () => {
    const onOpenReleasePage = vi.fn();
    // Not pinned: PwrAgent installs the newest build itself, so there is
    // nothing to ask the operator for.
    expect(buildManagedGrokBuildNotice({
      entry: grokEntry(undefined, {
        managedBuild: { ...managed, pinnedBehind: false },
        pwrAgentManagedRuntime: true,
      }),
      onOpenReleasePage,
    })).toBeUndefined();
    // A vendor install is on the other channel entirely.
    expect(buildManagedGrokBuildNotice({
      entry: grokEntry(undefined, { managedBuild: managed }),
      onOpenReleasePage,
    })).toBeUndefined();
    expect(buildManagedGrokBuildNotice({
      entry: grokEntry(undefined, { pwrAgentManagedRuntime: true }),
      onOpenReleasePage,
    })).toBeUndefined();
  });
});
