import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AppServerThreadMessageEntry } from "@pwragent/shared";
import { TranscriptMessage } from "../TranscriptMessage";

const IMAGE = `<linear-image quality="preview">${JSON.stringify({
  type: "image",
  attrs: { src: "https://uploads.linear.app/org/issue/file?signature=x", alt: "attention-lens.png" },
})}</linear-image>`;
const ISSUE = [
  '<issue identifier="PWR-5">',
  "<title>Mark Read hotkey in Attention lens</title>",
  "<description>",
  "## Report",
  "",
  "The hotkey does **nothing**.",
  IMAGE,
  "</description>",
  '<team name="PwrDrvr"/>',
  "<label>Bug</label>",
  '<project name="PwrAgent"/>',
  "</issue>",
].join("\n");

function renderMessage(
  overrides: Partial<AppServerThreadMessageEntry> = {},
  copyText = vi.fn(),
) {
  return render(<TranscriptMessage
    parentThreadId="linear-test"
    parentThreadBackend="claude"
    skills={[]}
    desktopApi={{ copyText }}
    message={{ type: "message", id: "linear-paste", role: "user", text: ISSUE, ...overrides }}
  />);
}

describe("text pasted from Linear in the transcript", () => {
  it("shows a copied issue as its header and Markdown description", () => {
    const { container } = renderMessage({ text: `Please fix this.\n\n${ISSUE}` });

    const issue = screen.getByRole("region", { name: "Linear issue PWR-5" });
    expect(within(issue).getByText("PWR-5")).toBeInTheDocument();
    expect(within(issue).getByText("Mark Read hotkey in Attention lens")).toBeInTheDocument();
    const details = within(issue).getByRole("list", { name: "Issue details" });
    expect(within(details).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["PwrDrvr", "PwrAgent", "Bug"]);
    expect(within(issue).getByRole("heading", { name: "Report" })).toBeInTheDocument();
    expect(within(issue).getByText("nothing").tagName).toBe("STRONG");
    expect(within(issue).getByText("attention-lens.png")).toBeInTheDocument();
    expect(screen.getByText("Please fix this.")).toBeInTheDocument();
    expect(container.textContent).not.toContain("<issue");
    expect(container.textContent).not.toContain("<linear-image");
    expect(container.textContent).not.toContain("signature");
  });

  it("copies the original prompt", async () => {
    const copyText = vi.fn().mockResolvedValue(undefined);
    renderMessage({}, copyText);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    });

    expect(copyText).toHaveBeenCalledWith(ISSUE);
  });

  it("names each image of a description copied without its issue", () => {
    const { container } = renderMessage({ text: `See the screenshot:\n${IMAGE}` });

    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.getByText("See the screenshot:")).toBeInTheDocument();
    expect(screen.getByText("attention-lens.png")).toBeInTheDocument();
    expect(container.textContent).not.toContain("<linear-image");
  });

  it.each([
    ["a malformed wrapper", '<issue identifier="PWR-5"><title>Unclosed</title>'],
    ["text that is not from Linear", "Use <issues> sparingly."],
  ])("renders %s as it always has", (_label, text) => {
    const { container } = renderMessage({ text });

    expect(screen.queryByRole("region")).toBeNull();
    expect(container.textContent).toContain(text);
  });

  it("leaves an assistant's quoted wrapper alone", () => {
    const { container } = renderMessage({ role: "assistant" });

    expect(screen.queryByRole("region", { name: "Linear issue PWR-5" })).toBeNull();
    expect(container.textContent).toContain("Mark Read hotkey in Attention lens");
  });
});
