import { describe, expect, it, vi } from "vitest";
import type { AcpAgentSettingsEntry } from "@pwragent/shared";
import {
  buildGrokCliUpdateCommand,
  buildGrokCliUpdateNotice,
} from "../GrokCliUpdateNotice";

function grokEntry(
  update: AcpAgentSettingsEntry["update"],
  activeCommand?: string,
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
    ...(activeCommand ? { activeCommand } : {}),
  };
}

describe("buildGrokCliUpdateNotice", () => {
  it("builds a version-keyed durable update notice", () => {
    const onCopy = vi.fn();
    const notice = buildGrokCliUpdateNotice({
      entry: grokEntry({
        status: "available",
        checkedAt: 100,
        currentVersion: "0.2.118",
        latestVersion: "1.0.0",
      }),
      now: 200,
      onCopy,
      onDismiss: vi.fn(),
      onSnooze: vi.fn(),
    });

    expect(notice).toMatchObject({
      id: "acp-update:acp:grok:1.0.0",
      autoDismiss: false,
      message: "Grok 1.0.0 is available; 0.2.118 is installed.",
      copyText: "grok update",
    });
    notice?.actions?.[0]?.onClick();
    expect(onCopy).toHaveBeenCalledWith("grok update");
  });

  it("targets the selected executable in the displayed and copied command", () => {
    const onCopy = vi.fn();
    const notice = buildGrokCliUpdateNotice({
      entry: grokEntry(
        {
          status: "available",
          checkedAt: 100,
          currentVersion: "0.2.118",
          latestVersion: "1.0.0",
        },
        "/Applications/Grok CLI/bin/grok",
      ),
      now: 200,
      platform: "darwin",
      onCopy,
      onDismiss: vi.fn(),
      onSnooze: vi.fn(),
    });

    expect(notice).toMatchObject({
      copyText: "'/Applications/Grok CLI/bin/grok' update",
      detail:
        "Run '/Applications/Grok CLI/bin/grok' update in a terminal, then restart active Grok sessions.",
    });
    notice?.actions?.[0]?.onClick();
    expect(onCopy).toHaveBeenCalledWith(
      "'/Applications/Grok CLI/bin/grok' update",
    );
  });

  it("quotes selected executable paths for the platform shell", () => {
    expect(buildGrokCliUpdateCommand(
      "/opt/Grok's CLI/grok",
      "darwin",
    )).toBe("'/opt/Grok'\\''s CLI/grok' update");
    expect(buildGrokCliUpdateCommand(
      "C:\\Program Files\\Grok's CLI\\grok.exe",
      "win32",
    )).toBe("& 'C:\\Program Files\\Grok''s CLI\\grok.exe' update");
  });

  it("hides dismissed, snoozed, current, and failed checks", () => {
    const callbacks = {
      onCopy: vi.fn(),
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
