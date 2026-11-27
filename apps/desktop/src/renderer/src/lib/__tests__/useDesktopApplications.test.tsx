import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  DesktopApplicationsSnapshot,
  ReadDesktopApplicationsRequest,
} from "@pwragent/shared/contracts/settings";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../desktop-api";
import { readPeerApplications, useDesktopApplications } from "../useDesktopApplications";

function applications(params: {
  editorId?: string;
  terminalId?: string;
}): DesktopApplicationsSnapshot {
  return {
    editors: params.editorId
      ? [{
          id: params.editorId,
          kind: "editor",
          name: params.editorId,
          source: "application",
          canOpenWorkspace: true,
        }]
      : [],
    terminals: params.terminalId
      ? [{
          id: params.terminalId,
          kind: "terminal",
          name: params.terminalId,
          source: "application",
          canOpenWorkspace: true,
        }]
      : [],
    preferredEditorId: { value: "", source: "default" },
    preferredTerminalId: { value: "", source: "default" },
    gh: {
      enabled: { value: false, source: "default" },
      path: { value: "", source: "default" },
      discovery: { candidates: [] },
    },
    git: {
      path: { value: "", source: "default" },
      discovery: { candidates: [] },
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("useDesktopApplications", () => {
  it("fails closed until the selected peer's applications are available", async () => {
    const guestApplications = deferred<{
      applications: DesktopApplicationsSnapshot;
    }>();
    const hostApplications = deferred<{
      applications: DesktopApplicationsSnapshot;
    }>();
    const readApplications = vi.fn((request: ReadDesktopApplicationsRequest) =>
      request.federationTarget?.scope === "remote"
      && request.federationTarget.instanceId === "guest"
        ? guestApplications.promise
        : hostApplications.promise
    );
    const desktopApi = { readApplications } as DesktopApi;
    const localApplications = applications({ editorId: "host-vscode" });
    const { rerender, result } = renderHook(
      ({ remoteInstanceId }: { remoteInstanceId?: string }) =>
        useDesktopApplications({
          desktopApi,
          localApplications,
          remoteInstanceId,
        }),
      { initialProps: { remoteInstanceId: "guest" } },
    );

    expect(result.current).toBeUndefined();
    expect(readApplications).toHaveBeenCalledWith({
      federationTarget: { scope: "remote", instanceId: "guest" },
    });

    await act(async () => {
      guestApplications.resolve({
        applications: applications({ terminalId: "guest-terminal" }),
      });
    });
    await waitFor(() => {
      expect(result.current?.terminals[0]?.id).toBe("guest-terminal");
    });
    expect(result.current?.editors).toEqual([]);

    rerender({ remoteInstanceId: "host" });
    expect(result.current).toBeUndefined();
    expect(readApplications).toHaveBeenLastCalledWith({
      federationTarget: { scope: "remote", instanceId: "host" },
    });
  });

  it("revalidates the owner's grant after a disconnect within the discovery cache lifetime", async () => {
    const readApplications = vi.fn().mockResolvedValueOnce({ applications: applications({ terminalId: "peer-term" }) })
      .mockRejectedValueOnce(new Error("remote_window revoked"));
    const desktopApi = { readApplications } as unknown as DesktopApi;
    const { result, rerender } = renderHook(({ suspended }) =>
      useDesktopApplications({ desktopApi, remoteInstanceId: "guest", suspended }), { initialProps: { suspended: false } });
    await waitFor(() => expect(result.current?.terminals[0]?.id).toBe("peer-term"));
    rerender({ suspended: true });
    expect(result.current).toBeUndefined();
    await act(async () => rerender({ suspended: false }));
    expect(readApplications).toHaveBeenCalledTimes(2);
    expect(result.current).toBeUndefined();
  });

  it("shares the reconnect read even after the old connection's timer expires", async () => {
    vi.useFakeTimers();
    try {
      const read = vi.fn(async () => ({ applications: applications({ terminalId: "peer-terminal" }) }));
      const desktopApi = { readApplications: read } as unknown as DesktopApi;
      const view = renderHook(({ suspended }) =>
        useDesktopApplications({ desktopApi, remoteInstanceId: "guest", suspended }), { initialProps: { suspended: false } });
      await act(async () => { await readPeerApplications(read, "guest"); });
      vi.advanceTimersByTime(10_000);
      view.rerender({ suspended: true });
      await act(async () => view.rerender({ suspended: false }));
      vi.advanceTimersByTime(20_000);
      await readPeerApplications(read, "guest");
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the local settings snapshot when no peer is selected", () => {
    const localApplications = applications({ editorId: "host-vscode" });
    const readApplications = vi.fn();
    const { result } = renderHook(() =>
      useDesktopApplications({
        desktopApi: { readApplications } as DesktopApi,
        localApplications,
      })
    );

    expect(result.current).toBe(localApplications);
    expect(readApplications).not.toHaveBeenCalled();
  });
});
