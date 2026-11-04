import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RestartGateStatus } from "../../../../../shared/restart-gate";
import {
  RESTART_GATE_NOTICE_ID,
  RestartGateNotice,
  buildRestartGateNotice,
} from "../RestartGateNotice";
import type { AppNoticeToastNotice } from "../AppNoticeToast";

afterEach(cleanup);

const RESUMING: RestartGateStatus = { phase: "resuming", waiting: 3, nextAt: 1_000, releaseBy: 9_000 };
const formatTime = (at: number) => `t${at}`;

describe("buildRestartGateNotice", () => {
  it("says what is waiting and offers to start everything now", () => {
    const onRelease = vi.fn();
    const notice = buildRestartGateNotice({ formatTime, onRelease, releasing: false, status: RESUMING });
    expect(notice).toMatchObject({
      autoDismiss: false,
      id: RESTART_GATE_NOTICE_ID,
      title: "Continuing after restart",
      facts: [
        { label: "Next start", value: "t1000" },
        { label: "Everything starts by", value: "t9000" },
      ],
    });
    expect(notice?.message).toBe(
      "3 threads stopped for the restart will continue a few at a time."
      + " Other queued messages, automations and Continue After wait until they start.",
    );
    expect(notice?.actions?.map((action) => action.label)).toEqual(["Start everything now"]);
    notice?.actions?.[0]?.onClick();
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it("shows nothing unless continuations are waiting", () => {
    const base = { formatTime, onRelease: vi.fn(), releasing: false };
    expect(buildRestartGateNotice({ ...base, status: { phase: "open" } })).toBeUndefined();
    expect(buildRestartGateNotice({ ...base, status: { phase: "quieting" } })).toBeUndefined();
  });

  it("omits times not yet scheduled and hides the action while releasing", () => {
    const notice = buildRestartGateNotice({
      formatTime,
      onRelease: vi.fn(),
      releasing: true,
      status: { phase: "resuming", waiting: 1 },
    });
    expect(notice?.facts).toBeUndefined();
    expect(notice?.message.startsWith("1 thread stopped")).toBe(true);
    expect(notice?.actions).toBeUndefined();
    expect(notice?.status).toEqual({ label: "Starting everything…", state: "progress" });
  });
});

describe("RestartGateNotice", () => {
  it("follows the gate, stays closed once dismissed, and returns on the next restart", async () => {
    let push: ((status: RestartGateStatus) => void) | undefined;
    const desktopApi = {
      getRestartGateStatus: vi.fn(async () => RESUMING),
      onRestartGateStatusChanged: vi.fn((callback: (status: RestartGateStatus) => void) => {
        push = callback;
        return () => undefined;
      }),
      releaseRestartGate: vi.fn(async (): Promise<RestartGateStatus> => ({ phase: "open" })),
    };
    const notices: Array<AppNoticeToastNotice | undefined> = [];
    render(<RestartGateNotice desktopApi={desktopApi} onNoticeChanged={(notice) => notices.push(notice)} />);
    await act(async () => {});
    expect(notices.at(-1)?.id).toBe(RESTART_GATE_NOTICE_ID);

    act(() => notices.at(-1)?.actions?.[0]?.onClick());
    expect(desktopApi.releaseRestartGate).toHaveBeenCalledTimes(1);
    expect(notices.at(-1)?.status?.state).toBe("progress");

    act(() => push?.({ phase: "open" }));
    expect(notices.at(-1)).toBeUndefined();

    act(() => push?.(RESUMING));
    expect(notices.at(-1)?.actions?.map((action) => action.label)).toEqual(["Start everything now"]);
    act(() => notices.at(-1)?.onDismiss?.());
    expect(notices.at(-1)).toBeUndefined();
    act(() => push?.({ ...RESUMING, waiting: 2 }));
    expect(notices.at(-1)).toBeUndefined();

    act(() => push?.({ phase: "open" }));
    act(() => push?.(RESUMING));
    expect(notices.at(-1)?.id).toBe(RESTART_GATE_NOTICE_ID);
  });

  it("keeps a change pushed while the first read is in flight", async () => {
    let push: ((status: RestartGateStatus) => void) | undefined;
    let answer: ((status: RestartGateStatus) => void) | undefined;
    const desktopApi = {
      getRestartGateStatus: vi.fn(() => new Promise<RestartGateStatus>((resolve) => {
        answer = resolve;
      })),
      onRestartGateStatusChanged: vi.fn((callback: (status: RestartGateStatus) => void) => {
        push = callback;
        return () => undefined;
      }),
      releaseRestartGate: vi.fn(async (): Promise<RestartGateStatus> => ({ phase: "open" })),
    };
    const notices: Array<AppNoticeToastNotice | undefined> = [];
    render(<RestartGateNotice desktopApi={desktopApi} onNoticeChanged={(notice) => notices.push(notice)} />);
    act(() => push?.({ phase: "open" }));
    // The read was taken before the gate opened; it must not bring the notice back.
    await act(async () => answer?.(RESUMING));
    expect(notices.at(-1)).toBeUndefined();
  });

  it("offers the action again when a release leaves continuations waiting", async () => {
    const desktopApi = {
      getRestartGateStatus: vi.fn(async () => RESUMING),
      onRestartGateStatusChanged: vi.fn(() => () => undefined),
      releaseRestartGate: vi.fn(async (): Promise<RestartGateStatus> => RESUMING),
    };
    const notices: Array<AppNoticeToastNotice | undefined> = [];
    render(<RestartGateNotice desktopApi={desktopApi} onNoticeChanged={(notice) => notices.push(notice)} />);
    await act(async () => {});
    await act(async () => notices.at(-1)?.actions?.[0]?.onClick());
    expect(notices.at(-1)?.actions?.map((action) => action.label)).toEqual(["Start everything now"]);
  });
});
