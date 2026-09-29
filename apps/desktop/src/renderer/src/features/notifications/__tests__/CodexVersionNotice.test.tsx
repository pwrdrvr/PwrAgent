import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopCodexVersionAdvisory,
  DesktopSettingsSnapshot,
} from "@pwragent/shared";
import {
  CodexVersionNotice,
  buildCodexVersionNotice,
} from "../CodexVersionNotice";
import type { AppNoticeToastNotice } from "../AppNoticeToast";

afterEach(cleanup);

function advisory(patch: Partial<DesktopCodexVersionAdvisory> = {}): DesktopCodexVersionAdvisory {
  return {
    version: "0.152.0",
    minimumVersion: "0.155.0",
    command: "/opt/homebrew/bin/codex",
    installer: "homebrew",
    upgradeCommand: "brew upgrade codex",
    ...patch,
  };
}

function build(patch: Partial<DesktopCodexVersionAdvisory> | null, extra: {
  dismissedVersion?: string;
} = {}) {
  const handlers = {
    onCopyCommand: vi.fn(),
    onDismiss: vi.fn(),
    onOpenCodexSettings: vi.fn(),
    onOpenReleasePage: vi.fn(),
  };
  const notice = buildCodexVersionNotice({
    advisory: patch === null ? undefined : advisory(patch),
    ...extra,
    ...handlers,
  });
  return { handlers, notice };
}

describe("buildCodexVersionNotice", () => {
  it("says what is missing and gives a Homebrew user the command to copy", () => {
    const { handlers, notice } = build({});
    expect(notice).toMatchObject({
      id: "codex-version:0.152.0",
      autoDismiss: false,
      tone: "warning",
      copyText: "brew upgrade codex",
    });
    expect(notice?.message).toBe(
      "Codex 0.152.0 is older than 0.155.0, so it can't use GPT-6-Sol, GPT-6.1-Sol and newer models.",
    );
    expect(notice?.detail).toContain("brew upgrade codex");

    const copy = notice?.actions?.find((action) => action.label === "Copy command");
    copy?.onClick();
    expect(handlers.onCopyCommand).toHaveBeenCalledWith("brew upgrade codex");
    notice?.actions?.find((action) => action.label === "Use PwrAgent build")?.onClick();
    expect(handlers.onOpenCodexSettings).toHaveBeenCalledOnce();
  });

  it("points an unrecognized install at the release page instead of inventing a command", () => {
    const { handlers, notice } = build({
      installer: "unknown",
      upgradeCommand: undefined,
    });
    expect(notice?.copyText).toBeUndefined();
    expect(notice?.detail).not.toMatch(/brew|npm/u);
    notice?.actions?.find((action) => action.label === "Open releases")?.onClick();
    expect(handlers.onOpenReleasePage).toHaveBeenCalledWith(
      "https://github.com/openai/codex/releases/latest",
    );
  });

  it("sends an app-bundled Codex to the managed build, with no command", () => {
    const { notice } = build({ installer: "application", upgradeCommand: undefined });
    expect(notice?.actions?.map((action) => action.label)).toEqual(["Use PwrAgent build"]);
    expect(notice?.copyText).toBeUndefined();
  });

  it("tells a stale PwrAgent build to check for updates rather than install anything", () => {
    const { notice } = build({ installer: "pwragent", upgradeCommand: undefined });
    expect(notice?.title).toBe("PwrAgent's Codex build is out of date");
    expect(notice?.actions?.map((action) => action.label)).toEqual(["Open Codex settings"]);
  });

  it("stays quiet with no advisory, or once the version was dismissed", () => {
    expect(build(null).notice).toBeUndefined();
    expect(build({}, { dismissedVersion: "0.152.0" }).notice).toBeUndefined();
    // A different old version is new information.
    expect(build({ version: "0.153.0" }, { dismissedVersion: "0.152.0" }).notice)
      .toBeDefined();
  });

  it("closing the toast records the version", () => {
    const { handlers, notice } = build({});
    notice?.onDismiss?.();
    expect(handlers.onDismiss).toHaveBeenCalledWith("0.152.0");
  });
});

describe("CodexVersionNotice", () => {
  function snapshot(value: DesktopCodexVersionAdvisory | undefined): DesktopSettingsSnapshot {
    return { models: { codex: { versionAdvisory: value } } } as unknown as DesktopSettingsSnapshot;
  }

  it("shows once at startup and does not re-show for an unchanged advisory", () => {
    // App passes stable callbacks (`useCallback`), so the test does too.
    const openSettings = () => undefined;
    const seen: Array<AppNoticeToastNotice | undefined> = [];
    const onNoticeChanged = (notice: AppNoticeToastNotice | undefined) => {
      seen.push(notice);
    };
    const { rerender } = render(
      <CodexVersionNotice
        snapshot={snapshot(advisory())}
        onNoticeChanged={onNoticeChanged}
        onOpenCodexSettings={openSettings}
      />,
    );
    expect(seen.map((notice) => notice?.id)).toEqual(["codex-version:0.152.0"]);

    // A later snapshot with an equal but new advisory object.
    rerender(
      <CodexVersionNotice
        snapshot={snapshot(advisory())}
        onNoticeChanged={onNoticeChanged}
        onOpenCodexSettings={openSettings}
      />,
    );
    expect(seen).toHaveLength(1);

    // Updating Codex clears it.
    rerender(
      <CodexVersionNotice
        snapshot={snapshot(undefined)}
        onNoticeChanged={onNoticeChanged}
        onOpenCodexSettings={openSettings}
      />,
    );
    expect(seen.at(-1)).toBeUndefined();
  });

  it("stays dismissed for the launch after the toast is closed", () => {
    let latest: AppNoticeToastNotice | undefined;
    render(
      <CodexVersionNotice
        snapshot={snapshot(advisory())}
        onNoticeChanged={(notice) => {
          latest = notice;
        }}
        onOpenCodexSettings={() => undefined}
      />,
    );
    expect(latest).toBeDefined();
    act(() => latest?.onDismiss?.());
    expect(latest).toBeUndefined();
  });
});
