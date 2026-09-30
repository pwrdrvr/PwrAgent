import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerRestartStatus } from "@pwragent/shared";
import {
  CodexRestartNotice,
  buildCodexRestartNotice,
} from "../CodexRestartNotice";
import type { AppNoticeToastNotice } from "../AppNoticeToast";

afterEach(cleanup);

const STOPPED: CodexAppServerRestartStatus = {
  stopped: true,
  stoppedAt: 1_000,
  exits: 5,
  windowMs: 600_000,
  lastExit: { code: null, signal: "SIGSEGV" },
};

describe("buildCodexRestartNotice", () => {
  it("says why Codex is down and offers the restart", () => {
    const onRestart = vi.fn();
    const notice = buildCodexRestartNotice({
      attempt: { state: "idle" },
      onDismiss: vi.fn(),
      onRestart,
      status: STOPPED,
    });
    expect(notice).toMatchObject({
      autoDismiss: false,
      id: "codex-restart-stopped:1000",
      title: "Codex stopped",
      facts: [{ label: "Last exit", value: "signal SIGSEGV" }],
      tone: "error",
    });
    expect(notice?.message).toBe(
      "Codex stopped unexpectedly 5 times in 10 minutes, so PwrAgent stopped"
      + " restarting it. Codex threads can't run until it starts again.",
    );
    expect(notice?.actions?.map((action) => action.label)).toEqual(["Restart Codex"]);
    notice?.actions?.[0]?.onClick();
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it("shows nothing while restarts are running normally or after a dismissal", () => {
    const base = { attempt: { state: "idle" as const }, onDismiss: vi.fn(), onRestart: vi.fn() };
    expect(buildCodexRestartNotice({ ...base, status: { stopped: false } })).toBeUndefined();
    expect(buildCodexRestartNotice({ ...base, dismissedStoppedAt: 1_000, status: STOPPED }))
      .toBeUndefined();
  });

  it("hides the action while restarting and keeps a failed restart on screen", () => {
    const base = { onDismiss: vi.fn(), onRestart: vi.fn() };
    const restarting = buildCodexRestartNotice({
      ...base,
      attempt: { state: "restarting" },
      status: STOPPED,
    });
    expect(restarting?.actions).toBeUndefined();
    expect(restarting?.status).toEqual({ label: "Restarting Codex…", state: "progress" });

    const failed = buildCodexRestartNotice({
      ...base,
      attempt: { state: "failed", error: "json-rpc transport closed" },
      status: { stopped: false },
    });
    expect(failed).toMatchObject({
      message: "Codex did not start again.",
      status: { label: "json-rpc transport closed", state: "error" },
    });
    expect(failed?.actions?.map((action) => action.label)).toEqual(["Restart Codex"]);
  });
});

describe("CodexRestartNotice", () => {
  it("follows main's status and clears the notice after a restart", async () => {
    let push: ((status: CodexAppServerRestartStatus) => void) | undefined;
    const desktopApi = {
      getCodexRestartStatus: vi.fn(async () => ({ stopped: false as const })),
      onCodexRestartStatusChanged: vi.fn((callback: (status: CodexAppServerRestartStatus) => void) => {
        push = callback;
        return () => undefined;
      }),
      restartCodex: vi.fn(async () => ({ status: { stopped: false as const } })),
    };
    const notices: Array<AppNoticeToastNotice | undefined> = [];
    render(
      <CodexRestartNotice
        desktopApi={desktopApi}
        onNoticeChanged={(notice) => notices.push(notice)}
      />,
    );
    await act(async () => { await Promise.resolve(); });
    expect(notices.at(-1)).toBeUndefined();

    act(() => push?.(STOPPED));
    expect(notices.at(-1)?.id).toBe("codex-restart-stopped:1000");

    await act(async () => { notices.at(-1)?.actions?.[0]?.onClick(); });
    expect(desktopApi.restartCodex).toHaveBeenCalledTimes(1);
    expect(notices.at(-1)).toBeUndefined();
  });

  it("drops a failed attempt's error when the breaker opens again", async () => {
    let push: ((status: CodexAppServerRestartStatus) => void) | undefined;
    const desktopApi = {
      getCodexRestartStatus: vi.fn(async () => STOPPED),
      onCodexRestartStatusChanged: vi.fn((callback: (status: CodexAppServerRestartStatus) => void) => {
        push = callback;
        return () => undefined;
      }),
      restartCodex: vi.fn(async () => ({
        status: { stopped: false as const },
        error: "json-rpc transport closed",
      })),
    };
    const notices: Array<AppNoticeToastNotice | undefined> = [];
    render(
      <CodexRestartNotice
        desktopApi={desktopApi}
        onNoticeChanged={(notice) => notices.push(notice)}
      />,
    );
    await act(async () => { await Promise.resolve(); });
    await act(async () => { notices.at(-1)?.actions?.[0]?.onClick(); });
    expect(notices.at(-1)?.status?.label).toBe("json-rpc transport closed");

    act(() => push?.({ ...STOPPED, stoppedAt: 2_000 }));
    expect(notices.at(-1)?.id).toBe("codex-restart-stopped:2000");
    expect(notices.at(-1)?.status).toBeUndefined();
  });
});
