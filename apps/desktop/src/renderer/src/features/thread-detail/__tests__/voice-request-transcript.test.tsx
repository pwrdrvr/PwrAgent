import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AppServerThreadMessageEntry } from "@pwragent/shared";
import { TranscriptMessage } from "../TranscriptMessage";

const request = "Please check the release configuration.";
const context = "assistant: Let me take a look.\nuser: The release configuration needs checking.";
const envelope = `<realtime_delegation>\n<input>${request}</input>\n<transcript_delta>${context}</transcript_delta>\n</realtime_delegation>`;

function renderMessage(overrides: Partial<AppServerThreadMessageEntry> = {}, copyText = vi.fn()) {
  return render(<TranscriptMessage
    parentThreadId="voice-test"
    parentThreadBackend="codex"
    skills={[]}
    desktopApi={{ copyText }}
    message={{ type: "message", id: "voice-request", role: "user", text: envelope, ...overrides }}
  />);
}

describe("voice requests in the chat transcript", () => {
  it("shows the delegated request with voice attribution and collapses the spoken context", () => {
    const { container } = renderMessage();
    expect(screen.getByText("Voice request")).toBeInTheDocument();
    expect(screen.getByText(request)).toBeVisible();
    expect(screen.queryByText(context)).not.toBeInTheDocument();
    expect(container.textContent).not.toContain("<realtime_delegation>");
    expect(container.textContent).not.toContain("<input>");
    const toggle = screen.getByRole("button", { name: "Voice context" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/assistant: Let me take a look/)).toBeVisible();
    expect(container.textContent).not.toContain("<transcript_delta>");
    fireEvent.click(toggle);
    expect(screen.queryByText(/assistant: Let me take a look/)).not.toBeInTheDocument();
  });

  it("copies the readable request and context without the protocol wrapper", async () => {
    const copyText = vi.fn().mockResolvedValue(undefined);
    renderMessage({}, copyText);
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    expect(copyText).toHaveBeenCalledWith(`${request}\n\nVoice context\n${context}`);
  });

  it("handles a request without spoken context", () => {
    renderMessage({ text: `<realtime_delegation>\n<input>${request}</input>\n</realtime_delegation>` });
    expect(screen.getByText("Voice request")).toBeInTheDocument();
    expect(screen.getByText(request)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Voice context" })).not.toBeInTheDocument();
  });

  it("uses protocol text parts and preserves accompanying images", () => {
    renderMessage({ text: "", parts: [
      { type: "text", text: envelope },
      { type: "image", url: "data:image/png;base64,QQ==" },
    ] });
    expect(screen.getByText("Voice request")).toBeInTheDocument();
    expect(screen.getByText(request)).toBeVisible();
    expect(screen.getByRole("button", { name: /Expand transcript image/ })).toBeInTheDocument();
  });

  it.each([
    `Example:\n${envelope}`,
    `<realtime_delegation><input>${request}</input>`,
    `<realtime_delegation><input> </input></realtime_delegation>`,
    `<realtime_delegation><input>${request}</input><unknown>Keep this</unknown></realtime_delegation>`,
    request,
  ])("preserves ordinary text and unsupported envelopes: %s", (text) => {
    const { container } = renderMessage({ text });
    expect(screen.queryByText("Voice request")).not.toBeInTheDocument();
    expect(container.textContent).toContain(text);
  });

  it("does not reinterpret assistant messages containing the same XML", () => {
    const { container } = renderMessage({ role: "assistant" });
    expect(screen.queryByText("Voice request")).not.toBeInTheDocument();
    expect(container.textContent).toContain("<realtime_delegation>");
  });
});
