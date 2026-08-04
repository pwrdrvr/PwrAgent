import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  DesktopApplicationsSnapshot,
  ReadDesktopApplicationsRequest,
} from "@pwragent/shared";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../desktop-api";
import { useDesktopApplications } from "../useDesktopApplications";

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
      path: { value: "", source: "default" },
      discovery: { candidates: [] },
    },
    git: { discovery: { candidates: [] } },
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
