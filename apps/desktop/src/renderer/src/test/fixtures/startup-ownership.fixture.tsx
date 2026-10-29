import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { DesktopApi } from "../../lib/desktop-api";
import { renderThreadApp } from "../render-thread-app";

afterEach(async () => {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  cleanup();
});

it("times out while the admitted renderer import is pending", async () => {
  const api: DesktopApi = {};
  await renderThreadApp(api, async () => {
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<button>Pending shell</button>); });
    // The import was admitted, but its completion has not arrived yet.
    api.recordStartupProfileEvent?.("thread-view-import:start");
    return view;
  });
}, 100);

it("renders independently after the previous test timed out", () => {
  render(<button>Independent render</button>);
  expect(screen.getByRole("button", { name: "Independent render" }).textContent).toBe("Independent render");
});
