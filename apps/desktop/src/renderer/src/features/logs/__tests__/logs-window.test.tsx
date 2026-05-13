import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogsWindow, buildRenderedLogLines } from "../LogsWindow";
import type { DesktopApi } from "../../../lib/desktop-api";

afterEach(() => {
  cleanup();
  delete (window as Window & { pwragent?: unknown }).pwragent;
});

describe("buildRenderedLogLines", () => {
  it("counts case-insensitive matches across log lines", () => {
    const result = buildRenderedLogLines(
      "INFO booted\nwarn retry\nINFO ready",
      "info",
    );

    expect(result.matchCount).toBe(2);
    expect(result.lines[0].parts).toEqual([
      { text: "INFO", matchIndex: 0 },
      { text: " booted" },
    ]);
    expect(result.lines[2].parts).toEqual([
      { text: "INFO", matchIndex: 1 },
      { text: " ready" },
    ]);
  });
});

describe("LogsWindow", () => {
  it("loads a log snapshot and renders search controls", async () => {
    const desktopApi = {
      readAppLogSnapshot: vi.fn(async () => ({
        kind: "log-snapshot",
        title: "Logs",
        path: "/Users/huntharo/Library/Logs/PwrAgent/main.log",
        content: "INFO booted\nWARN retry\n",
        sizeBytes: 24,
        readAt: Date.now(),
        truncated: false,
      })),
      copyText: vi.fn(async () => undefined),
    } as unknown as DesktopApi;
    (window as Window & { pwragent?: DesktopApi }).pwragent = desktopApi;

    render(<LogsWindow />);

    expect(await screen.findByLabelText("Search logs")).toBeInTheDocument();
    expect(await screen.findByText("INFO booted")).toBeInTheDocument();
    expect(screen.getByText("/Users/huntharo/Library/Logs/PwrAgent/main.log"))
      .toBeInTheDocument();
    await waitFor(() => {
      expect(desktopApi.readAppLogSnapshot).toHaveBeenCalled();
    });
  });
});
