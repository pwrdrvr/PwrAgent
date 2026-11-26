import "@testing-library/jest-dom/vitest";
import { fireEvent, render, within } from "@testing-library/react";
import { expect, it } from "vitest";
import type { AppServerThreadMessageEntry } from "@pwragent/shared/contracts/normalized-app-server";
import { TranscriptList } from "../TranscriptList";

const marker = '::browser-complete{title="Verified preview"}';
const completion: AppServerThreadMessageEntry = {
  type: "message",
  id: "browser-completion",
  role: "assistant",
  phase: "commentary",
  text: marker,
  turn: { id: "browser-turn", status: "in_progress" },
};
const listProps = { loading: false, loadingMore: false, onLoadOlder: async () => undefined };

it("renders the browser headline as activity in the original transcript row", () => {
  const view = render(
    <TranscriptList {...listProps} activeTurnId="browser-turn"
      entries={[completion]} parentThreadBackend="codex" />,
  );
  try {
    const row = view.getByRole("listitem");
    expect(row).toHaveAttribute("data-entry-id", "browser-completion");
    expect(within(row).getByText("Verified preview")).toHaveClass("transcript-activity__label");
    expect(within(row).queryByText(marker)).toBeNull();
  } finally {
    view.unmount();
  }
});

it("renders the same activity when expanding a reopened transcript", () => {
  const view = render(
    <TranscriptList {...listProps} entries={[{
      ...completion,
      turn: { id: "browser-turn", status: "completed" },
    }]} parentThreadBackend="codex" />,
  );
  try {
    fireEvent.click(view.getByRole("button", { name: "1 previous message" }));
    expect(view.getByText("Verified preview")).toHaveClass("transcript-activity__label");
    expect(view.queryByText(marker)).toBeNull();
  } finally {
    view.unmount();
  }
});
