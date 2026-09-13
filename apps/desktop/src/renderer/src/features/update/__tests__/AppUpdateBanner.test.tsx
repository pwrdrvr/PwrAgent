import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AppUpdateCheckResult,
  AppUpdateStatus,
} from "../../../../../shared/app-metadata";
import type { DesktopApi } from "../../../lib/desktop-api";
import type { AppNoticeToastNotice } from "../../notifications/AppNoticeToast";
import { AppUpdateBanner } from "../AppUpdateBanner";

afterEach(() => {
  cleanup();
});

function renderBanner(initialStatus: AppUpdateStatus) {
  let listener: ((status: AppUpdateStatus) => void) | undefined;
  let resultListener: ((result: AppUpdateCheckResult) => void) | undefined;
  const notices: AppNoticeToastNotice[] = [];
  const dismissed: string[] = [];
  const desktopApi = {
    readAppUpdateStatus: vi.fn(async () => initialStatus),
    onAppUpdateStatus: vi.fn((callback: (status: AppUpdateStatus) => void) => {
      listener = callback;
      return vi.fn();
    }),
    onAppUpdateCheckResult: vi.fn(
      (callback: (result: AppUpdateCheckResult) => void) => {
        resultListener = callback;
        return vi.fn();
      },
    ),
    cancelAppUpdateDownload: vi.fn(async () => ({ canceled: true })),
    installAppUpdate: vi.fn(async () => ({ status: "restarting" as const })),
  } satisfies DesktopApi;

  render(
    <AppUpdateBanner
      desktopApi={desktopApi}
      showNotice={(notice) => notices.push(notice)}
      dismissNotice={(id) => dismissed.push(id)}
    />,
  );
  return {
    desktopApi,
    notices,
    dismissed,
    emit: (status: AppUpdateStatus) => listener?.(status),
    emitResult: (result: AppUpdateCheckResult) => resultListener?.(result),
  };
}

function progressBar(): HTMLElement | null {
  return document.querySelector("[role='progressbar']");
}

describe("AppUpdateBanner", () => {
  it("appears when an update has been downloaded", async () => {
    renderBanner({ status: "downloaded", version: "1.2.3" });

    expect(
      await screen.findByText("Restart to update to v1.2.3."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart" })).toBeEnabled();
  });

  it("names a downgrade as a channel switch rather than an update", async () => {
    renderBanner({
      status: "downloaded",
      version: "1.0.2",
      direction: "downgrade",
    });

    expect(
      await screen.findByText("Restart to switch to v1.0.2."),
    ).toBeInTheDocument();
    expect(screen.getByText("Switch ready")).toBeInTheDocument();
    expect(screen.queryByText(/Restart to update/)).not.toBeInTheDocument();
  });

  it("stays hidden before the update is ready to install", async () => {
    const { desktopApi, emit } = renderBanner({ status: "idle" });

    await waitFor(() => {
      expect(desktopApi.onAppUpdateStatus).toHaveBeenCalledTimes(1);
    });
    act(() => {
      emit({ status: "available", version: "1.2.3" });
    });

    expect(screen.queryByText(/Restart to update/)).not.toBeInTheDocument();
  });

  it("calls the restart install IPC action", async () => {
    const { desktopApi } = renderBanner({
      status: "downloaded",
      version: "1.2.3",
    });

    fireEvent.click(await screen.findByRole("button", { name: "Restart" }));

    await waitFor(() => {
      expect(desktopApi.installAppUpdate).toHaveBeenCalledTimes(1);
    });
  });

  it("can be dismissed for the current downloaded version", async () => {
    const { desktopApi, emit } = renderBanner({ status: "idle" });

    await waitFor(() => {
      expect(desktopApi.onAppUpdateStatus).toHaveBeenCalledTimes(1);
    });
    emit({ status: "downloaded", version: "1.2.3" });
    expect(
      await screen.findByText("Restart to update to v1.2.3."),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss update notification" }),
    );

    expect(
      screen.queryByText("Restart to update to v1.2.3."),
    ).not.toBeInTheDocument();
  });

  it("reports a menu check live, without a notice to run out a countdown", async () => {
    const { desktopApi, notices, emitResult } = renderBanner({ status: "idle" });

    await waitFor(() => {
      expect(desktopApi.onAppUpdateCheckResult).toHaveBeenCalledTimes(1);
    });
    act(() => {
      emitResult({ status: "checking" });
    });

    // The live card, NOT a transient notice: the check has no fixed duration,
    // so nothing may drain toward a dismissal while it is still working.
    expect(screen.getByText("Checking for updates")).toBeInTheDocument();
    expect(notices).toHaveLength(0);
    // Indeterminate while the release read is out.
    expect(progressBar()?.getAttribute("aria-valuenow")).toBe(null);
    // And no Cancel yet: there is no download to stop.
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("follows the download with a meter and a way out", async () => {
    const { desktopApi, notices, emit, emitResult } = renderBanner({
      status: "idle",
    });

    await waitFor(() => {
      expect(desktopApi.onAppUpdateCheckResult).toHaveBeenCalledTimes(1);
    });
    act(() => {
      emitResult({ status: "checking" });
    });
    act(() => {
      emit({ status: "available", version: "1.0.0" });
    });
    expect(screen.getByText("Starting download of v1.0.0...")).toBeInTheDocument();
    // Cancel is live from `available`, before any byte moves — which is why
    // main registers its cancelable download at that same moment.
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();

    act(() => {
      emit({
        status: "downloading",
        version: "1.0.0",
        percent: 42,
        transferred: 50_000_000,
        total: 118_000_000,
        bytesPerSecond: 3_300_000,
      });
    });

    expect(screen.getByText("PwrAgent v1.0.0 - 42%")).toBeInTheDocument();
    expect(
      screen.getByText("48 MB of 113 MB - 3.1 MB/s"),
    ).toBeInTheDocument();
    expect(progressBar()?.getAttribute("aria-valuenow")).toBe("42");
    // Still nothing in the notice stack to expire.
    expect(notices).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(desktopApi.cancelAppUpdateDownload).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole("button", { name: "Canceling..." })).toBeDisabled();
  });

  it("hands a canceled download to the notice stack as an answer, not a failure", async () => {
    const { desktopApi, notices, emit, emitResult } = renderBanner({
      status: "idle",
    });

    await waitFor(() => {
      expect(desktopApi.onAppUpdateCheckResult).toHaveBeenCalledTimes(1);
    });
    act(() => {
      emitResult({ status: "checking" });
    });
    act(() => {
      emit({ status: "downloading", version: "1.0.0", percent: 42 });
    });
    // The check already returned `available`; the cancel lands on the status
    // channel, which is the only one still talking.
    act(() => {
      emit({ status: "canceled", version: "1.0.0" });
    });

    expect(screen.queryByText("Downloading update")).toBeNull();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.title).toBe("Download canceled");
    expect(notices[0]?.tone).toBe("neutral");
    // Nothing was downloaded, so nothing is offered to restart into.
    expect(screen.queryByRole("button", { name: "Restart" })).toBeNull();
  });

  it("keeps the live card up across the check returning available", async () => {
    // PwrAgent's check resolves at `available` and lets the updater's events
    // carry the download. Treating that as an outcome would take the card
    // down for the whole download it just started.
    const { desktopApi, notices, emit, emitResult } = renderBanner({
      status: "idle",
    });

    await waitFor(() => {
      expect(desktopApi.onAppUpdateCheckResult).toHaveBeenCalledTimes(1);
    });
    act(() => {
      emitResult({ status: "checking" });
    });
    act(() => {
      emit({ status: "available", version: "1.0.0" });
    });
    act(() => {
      emitResult({ status: "available", version: "1.0.0" });
    });
    act(() => {
      emit({ status: "downloading", version: "1.0.0", percent: 30 });
    });

    expect(screen.getByText("Downloading update")).toBeInTheDocument();
    expect(notices).toHaveLength(0);
  });

  it("stays silent while a background check downloads", async () => {
    const { desktopApi, notices, emit } = renderBanner({ status: "idle" });

    await waitFor(() => {
      expect(desktopApi.onAppUpdateStatus).toHaveBeenCalledTimes(1);
    });
    // No check result — nobody asked, so nothing may appear until there is
    // something to act on.
    act(() => {
      emit({ status: "checking" });
    });
    act(() => {
      emit({ status: "downloading", version: "1.0.0", percent: 30 });
    });

    expect(screen.queryByText("Downloading update")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(notices).toHaveLength(0);
  });

  it("picks the live card up mid-download when a check joins one", async () => {
    // Help -> Check for Updates while a background download is already running
    // joins it in main, so the `checking` tick arrives after the status has
    // moved on. Rewinding the card there would report a finished step.
    const { desktopApi, emitResult } = renderBanner({
      status: "downloading",
      version: "1.0.0",
      percent: 70,
    });

    await waitFor(() => {
      expect(desktopApi.onAppUpdateCheckResult).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(desktopApi.readAppUpdateStatus).toHaveBeenCalledTimes(1);
    });
    act(() => {
      emitResult({ status: "checking" });
    });

    expect(await screen.findByText("PwrAgent v1.0.0 - 70%")).toBeInTheDocument();
    expect(screen.queryByText("Checking for updates")).toBeNull();
  });

  it("drops the live card the moment the download is ready to install", async () => {
    const { desktopApi, notices, emit, emitResult } = renderBanner({
      status: "idle",
    });

    await waitFor(() => {
      expect(desktopApi.onAppUpdateCheckResult).toHaveBeenCalledTimes(1);
    });
    act(() => {
      emitResult({ status: "checking" });
    });
    act(() => {
      emit({ status: "downloading", version: "1.0.0", percent: 99 });
    });
    expect(screen.getByText("Downloading update")).toBeInTheDocument();

    act(() => {
      emit({ status: "downloaded", version: "1.0.0" });
    });

    expect(screen.queryByText("Downloading update")).toBeNull();
    expect(screen.getByText("Restart to update to v1.0.0.")).toBeInTheDocument();
    // The sticky card carries this outcome, so a notice repeating it would
    // say the same thing twice.
    expect(notices).toHaveLength(0);
  });

  it("hands a failed check to the notice stack and takes the card down", async () => {
    const { desktopApi, notices, emitResult } = renderBanner({ status: "idle" });

    await waitFor(() => {
      expect(desktopApi.onAppUpdateCheckResult).toHaveBeenCalledTimes(1);
    });
    act(() => {
      emitResult({ status: "checking" });
    });
    act(() => {
      emitResult({
        status: "error",
        message: "GitHub releases request failed with 404",
      });
    });

    expect(screen.queryByText("Checking for updates")).toBeNull();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.title).toBe("Update check failed");
    expect(notices[0]?.tone).toBe("error");
  });

  it("takes down the previous answer when the operator asks again", async () => {
    const { desktopApi, notices, dismissed, emitResult } = renderBanner({
      status: "idle",
    });

    await waitFor(() => {
      expect(desktopApi.onAppUpdateCheckResult).toHaveBeenCalledTimes(1);
    });
    act(() => {
      emitResult({ status: "checking" });
    });
    act(() => {
      emitResult({ status: "no-update", version: "0.8.0" });
    });
    expect(notices[0]?.title).toBe("PwrAgent is up to date");

    act(() => {
      emitResult({ status: "checking" });
    });

    // Otherwise the stale answer sits beside the card reporting the new check.
    expect(dismissed).toEqual([notices[0]?.id]);
  });

  it("brings a dismissed offer back when the operator checks again", async () => {
    const { desktopApi, emit, emitResult } = renderBanner({ status: "idle" });

    await waitFor(() => {
      expect(desktopApi.onAppUpdateStatus).toHaveBeenCalledTimes(1);
    });
    act(() => {
      emit({ status: "downloaded", version: "1.2.3" });
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss update notification" }),
    );
    expect(screen.queryByText("Restart to update to v1.2.3.")).toBeNull();

    // Asking again is asking to see the answer again.
    act(() => {
      emitResult({ status: "checking" });
    });
    act(() => {
      emit({ status: "downloaded", version: "1.2.3" });
    });

    expect(screen.getByText("Restart to update to v1.2.3.")).toBeInTheDocument();
  });

  it("keeps the standing offer when the operator checks again", async () => {
    // A check that joins an already-downloaded update must not tear the
    // Restart card down: main answers `downloaded` straight away and never
    // re-broadcasts the status, so anything the renderer overwrites here is
    // gone until the window reloads.
    const { desktopApi, emit, emitResult } = renderBanner({ status: "idle" });

    await waitFor(() => {
      expect(desktopApi.onAppUpdateCheckResult).toHaveBeenCalledTimes(1);
    });
    act(() => {
      emit({ status: "downloaded", version: "1.2.3" });
    });
    expect(screen.getByText("Restart to update to v1.2.3.")).toBeInTheDocument();

    act(() => {
      emitResult({ status: "checking" });
    });
    expect(screen.getByText("Restart to update to v1.2.3.")).toBeInTheDocument();

    act(() => {
      emitResult({ status: "downloaded", version: "1.2.3" });
    });

    expect(screen.getByText("Restart to update to v1.2.3.")).toBeInTheDocument();
  });

  it("does not let a stale initial read hide a newer downloaded event", async () => {
    let listener: ((status: AppUpdateStatus) => void) | undefined;
    let resolveInitialStatus:
      | ((status: AppUpdateStatus) => void)
      | undefined;
    const initialStatus = new Promise<AppUpdateStatus>((resolve) => {
      resolveInitialStatus = resolve;
    });
    const desktopApi = {
      readAppUpdateStatus: vi.fn(async () => await initialStatus),
      onAppUpdateStatus: vi.fn((callback: (status: AppUpdateStatus) => void) => {
        listener = callback;
        return vi.fn();
      }),
      installAppUpdate: vi.fn(async () => ({ status: "restarting" as const })),
    } satisfies DesktopApi;

    render(<AppUpdateBanner desktopApi={desktopApi} />);
    await waitFor(() => {
      expect(desktopApi.onAppUpdateStatus).toHaveBeenCalledTimes(1);
    });

    listener?.({ status: "downloaded", version: "1.2.3" });
    expect(
      await screen.findByText("Restart to update to v1.2.3."),
    ).toBeInTheDocument();

    resolveInitialStatus?.({ status: "available", version: "1.2.3" });

    await waitFor(() => {
      expect(
        screen.getByText("Restart to update to v1.2.3."),
      ).toBeInTheDocument();
    });
  });
});
