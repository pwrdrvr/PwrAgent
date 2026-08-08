import { describe, expect, it, vi } from "vitest";
import type { AcpAgentSettingsEntry } from "@pwragent/shared";
import {
  buildGrokCliUpdateNotice,
  GROK_BUILD_UPDATE_URL,
} from "../GrokCliUpdateNotice";

function grokEntry(
  update: AcpAgentSettingsEntry["update"],
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
  };
}

describe("buildGrokCliUpdateNotice", () => {
  it("builds a version-keyed durable update notice", () => {
    const onOpenUpdatePage = vi.fn();
    const notice = buildGrokCliUpdateNotice({
      entry: grokEntry({
        status: "available",
        checkedAt: 100,
        currentVersion: "0.2.118",
        latestVersion: "1.0.0",
      }),
      now: 200,
      onOpenUpdatePage,
      onDismiss: vi.fn(),
      onSnooze: vi.fn(),
    });

    expect(notice).toMatchObject({
      id: "acp-update:acp:grok:1.0.0",
      autoDismiss: false,
      message: "Grok 1.0.0 is available; 0.2.118 is installed.",
      detail:
        "Update Grok from x.ai/build, then restart active Grok sessions.",
    });
    notice?.actions?.[0]?.onClick();
    expect(onOpenUpdatePage).toHaveBeenCalledWith(GROK_BUILD_UPDATE_URL);
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
    expect(buildGrokCliUpdateNotice({
      entry: grokEntry({ ...available, dismissedAt: 150 }),
      now: 200,
      ...callbacks,
    })).toBeUndefined();
    expect(buildGrokCliUpdateNotice({
      entry: grokEntry({ ...available, snoozedUntil: 300 }),
      now: 200,
      ...callbacks,
    })).toBeUndefined();
    expect(buildGrokCliUpdateNotice({
      entry: grokEntry({ ...available, snoozedUntil: 199 }),
      now: 200,
      ...callbacks,
    })).toBeDefined();
    expect(buildGrokCliUpdateNotice({
      entry: grokEntry({ ...available, status: "up-to-date" }),
      now: 200,
      ...callbacks,
    })).toBeUndefined();
    expect(buildGrokCliUpdateNotice({
      entry: grokEntry({ ...available, status: "failed" }),
      now: 200,
      ...callbacks,
    })).toBeUndefined();
  });
});
