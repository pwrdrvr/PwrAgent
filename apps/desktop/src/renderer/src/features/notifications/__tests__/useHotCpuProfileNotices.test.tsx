import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  HotCpuFinalCaptureFailedEvent,
  HotCpuPostCapEvent,
  HotCpuProfileCapturedEvent,
  HotCpuRearmableCapture,
} from "../../../../../shared/hot-cpu-profile";
import type { AppNoticeAction } from "../app-notice-state";
import { useHotCpuProfileNotices } from "../useHotCpuProfileNotices";

afterEach(cleanup);

const finalAttempt = {
  capturedAt: "2026-11-25T18:00:00.000Z",
  captureLimit: 5,
  profileFilename: "main-hot-0005.cpuprofile",
  sessionDirectoryName: "hot-cpu-example",
  target: "main",
} as const;
const savedCapture = {
  ...finalAttempt,
  profilePath: "/example/main-hot-0005.cpuprofile",
  sessionDirectory: "/example",
  triggerConsecutiveSamples: 3,
  triggerCpuPercent: 68,
  triggerMode: "sustained",
  triggerThresholdPercent: 50,
} as const;

it.each([
  [savedCapture, "Main CPU profile captured"],
  [finalAttempt, "Main CPU profile capture failed"],
] as const)("restores the current Rearm offer on mount (%s)", async (capture, title) => {
  const rearmHotCpuProfile = vi.fn(async () => true);
  const listRearmableHotCpuProfiles = vi.fn(async () => [capture]);
  const dispatch = vi.fn<(action: AppNoticeAction) => void>();
  renderHook(() => useHotCpuProfileNotices({ rearmHotCpuProfile, listRearmableHotCpuProfiles }, dispatch));

  await waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
  const action = dispatch.mock.calls[0][0];
  expect(action).toMatchObject({
    type: "show",
    notice: { title, actions: [expect.objectContaining({ label: "Rearm" })] },
  });
  if (action.type !== "show") throw new Error("Expected a restored capture notice");
  await act(async () => { await action.notice.actions?.[0].onClick(); });
  expect(rearmHotCpuProfile).toHaveBeenCalledExactlyOnceWith({
    sessionDirectoryName: capture.sessionDirectoryName,
    profileFilename: capture.profileFilename,
  });
});

it("keeps the live offer when the reload snapshot returns late", async () => {
  const snapshot = Promise.withResolvers<HotCpuRearmableCapture[]>();
  let onCaptured: ((event: HotCpuProfileCapturedEvent) => void) | undefined;
  let onFailed: ((event: HotCpuFinalCaptureFailedEvent) => void) | undefined;
  const unsubscribe = vi.fn();
  const api = {
    listRearmableHotCpuProfiles: () => snapshot.promise,
    onHotCpuProfileCaptured: (callback: typeof onCaptured) => { onCaptured = callback; return unsubscribe; },
    onHotCpuFinalCaptureFailed: (callback: typeof onFailed) => { onFailed = callback; return unsubscribe; },
  };
  const dispatch = vi.fn<(action: AppNoticeAction) => void>();
  const { unmount } = renderHook(() => useHotCpuProfileNotices(api, dispatch));
  expect(onCaptured).toBeTypeOf("function");
  expect(onFailed).toBeTypeOf("function");
  act(() => onFailed?.({ ...finalAttempt, profileFilename: "main-hot-0010.cpuprofile" }));
  await act(async () => { snapshot.resolve([savedCapture]); });
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    type: "show", notice: expect.objectContaining({ title: "Main CPU profile capture failed" }),
  }));
  unmount();
  expect(unsubscribe).toHaveBeenCalledTimes(2);
});

it("offers the same Rearm on a post-cap notice when the capture notice is gone", async () => {
  let onPostCap: ((event: HotCpuPostCapEvent) => void) | undefined;
  const rearmHotCpuProfile = vi.fn(async () => true);
  const api = {
    rearmHotCpuProfile,
    onHotCpuPostCap: (callback: typeof onPostCap) => { onPostCap = callback; return () => {}; },
  };
  const dispatch = vi.fn<(action: AppNoticeAction) => void>();
  renderHook(() => useHotCpuProfileNotices(api, dispatch));
  const postCap = { captureCount: 5, capturedAt: finalAttempt.capturedAt, sessionId: "session", target: "main" } as const;

  // Without a live offer there is nothing to rearm.
  act(() => onPostCap?.(postCap));
  expect(dispatch.mock.lastCall?.[0]).toMatchObject({ type: "show" });
  const plain = dispatch.mock.lastCall?.[0];
  if (plain?.type !== "show") throw new Error("Expected a post-cap notice");
  expect(plain.notice.actions).toBeUndefined();

  act(() => onPostCap?.({
    ...postCap,
    rearm: {
      captureLimit: 5,
      profileFilename: finalAttempt.profileFilename,
      sessionDirectoryName: finalAttempt.sessionDirectoryName,
    },
  }));
  const action = dispatch.mock.lastCall?.[0];
  if (action?.type !== "show") throw new Error("Expected a post-cap notice");
  expect(action.notice).toMatchObject({
    title: "Main process high CPU detected after capture limit",
    actions: [expect.objectContaining({ label: "Rearm" })],
  });
  await act(async () => { await action.notice.actions?.[0].onClick(); });
  expect(rearmHotCpuProfile).toHaveBeenCalledExactlyOnceWith({
    sessionDirectoryName: finalAttempt.sessionDirectoryName,
    profileFilename: finalAttempt.profileFilename,
  });
  expect(dispatch.mock.lastCall?.[0]).toMatchObject({
    type: "update-durable",
    // Like the capture notice, a rearmed batch no longer claims to be at its limit.
    notice: {
      message: "CPU sampling continues.",
      status: { label: "Rearmed for up to 5 more captures.", state: "success" },
    },
  });
});

it("settles every toast that offers the same Rearm when one of them rearms", async () => {
  let onCaptured: ((event: HotCpuProfileCapturedEvent) => void) | undefined;
  let onPostCap: ((event: HotCpuPostCapEvent) => void) | undefined;
  const rearmHotCpuProfile = vi.fn(async () => true);
  const api = {
    rearmHotCpuProfile,
    onHotCpuProfileCaptured: (callback: typeof onCaptured) => { onCaptured = callback; return () => {}; },
    onHotCpuPostCap: (callback: typeof onPostCap) => { onPostCap = callback; return () => {}; },
  };
  const dispatch = vi.fn<(action: AppNoticeAction) => void>();
  renderHook(() => useHotCpuProfileNotices(api, dispatch));
  act(() => onCaptured?.(savedCapture));
  act(() => onPostCap?.({
    captureCount: 5,
    capturedAt: finalAttempt.capturedAt,
    sessionId: "session",
    target: "main",
    rearm: {
      captureLimit: 5,
      profileFilename: savedCapture.profileFilename,
      sessionDirectoryName: savedCapture.sessionDirectoryName,
    },
  }));
  const shown = dispatch.mock.calls.flatMap(([action]) => action.type === "show" ? [action.notice] : []);
  expect(shown).toHaveLength(2);
  const [capture, postCap] = shown;

  await act(async () => { await postCap.actions?.[0].onClick(); });
  const settled = dispatch.mock.calls.flatMap(([action]) =>
    action.type === "update-durable" && action.notice.status?.state === "success" ? [action.notice] : []);
  // The capture toast no longer offers a Rearm the main process would refuse.
  expect(settled.map((notice) => notice.id).sort()).toEqual([capture.id, postCap.id].sort());
  for (const notice of settled) {
    expect(notice.actions).toBeUndefined();
    expect(notice.status?.label).toBe("Rearmed for up to 5 more captures.");
  }
  expect(rearmHotCpuProfile).toHaveBeenCalledOnce();
});
