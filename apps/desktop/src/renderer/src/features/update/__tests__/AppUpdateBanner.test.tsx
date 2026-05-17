import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppUpdateStatus } from "../../../../../shared/app-metadata";
import type { DesktopApi } from "../../../lib/desktop-api";
import { AppUpdateBanner } from "../AppUpdateBanner";

afterEach(() => {
  cleanup();
});

function renderBanner(initialStatus: AppUpdateStatus) {
  let listener: ((status: AppUpdateStatus) => void) | undefined;
  const desktopApi = {
    readAppUpdateStatus: vi.fn(async () => initialStatus),
    onAppUpdateStatus: vi.fn((callback: (status: AppUpdateStatus) => void) => {
      listener = callback;
      return vi.fn();
    }),
    installAppUpdate: vi.fn(async () => ({ status: "restarting" as const })),
  } satisfies DesktopApi;

  render(<AppUpdateBanner desktopApi={desktopApi} />);
  return {
    desktopApi,
    emit: (status: AppUpdateStatus) => listener?.(status),
  };
}

describe("AppUpdateBanner", () => {
  it("appears when an update has been downloaded", async () => {
    renderBanner({ status: "downloaded", version: "1.2.3" });

    expect(
      await screen.findByText("Restart to update to v1.2.3."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart" })).toBeEnabled();
  });

  it("stays hidden before the update is ready to install", async () => {
    renderBanner({ status: "available", version: "1.2.3" });

    await waitFor(() => {
      expect(screen.queryByText(/Restart to update/)).not.toBeInTheDocument();
    });
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
