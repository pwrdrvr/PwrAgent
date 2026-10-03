import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeVoiceApi } from "../../../../../shared/native-voice";
import type { VoiceView } from "../native-voice-controller";

const mocks = vi.hoisted(() => ({
  view: { status: "listening", muted: false, transcript: [], actions: [] } as VoiceView,
  controller: { setCamera: vi.fn(), cameraStream: vi.fn(), dismissCameraError: vi.fn() },
}));
vi.mock("../NativeVoice", () => ({ useNativeVoice: () => mocks }));
import { VoiceCameraButton } from "../VoiceCameraButton";

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 10, y: 10, left: 10, right: 42, top: 10, bottom: 42, width: 32, height: 32, toJSON: () => ({}) });
});
afterEach(() => {
  cleanup();
  mocks.view = { status: "listening", muted: false, transcript: [], actions: [] };
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
describe("camera voice control", () => {
  it("shows only during live voice and requests explicit opt-in on click", () => {
    const result = render(<VoiceCameraButton api={{} as NativeVoiceApi} />);
    fireEvent.click(screen.getByRole("button", { name: "Turn on camera cues" }));
    expect(mocks.controller.setCamera).toHaveBeenCalledWith(true);
    mocks.view.status = "idle";
    result.rerender(<VoiceCameraButton api={{} as NativeVoiceApi} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
  it("can cancel a pending camera permission request", () => {
    mocks.view.camera = "starting";
    render(<VoiceCameraButton api={{} as NativeVoiceApi} />);
    const button = screen.getByRole("button", { name: "Turn off camera cues" });
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(mocks.controller.setCamera).toHaveBeenCalledWith(false);
    expect(screen.getByRole("status")).toHaveTextContent("Starting camera");
  });
  it("makes a camera-only failure visible and dismissible", () => {
    mocks.view.cameraError = "Clef unavailable";
    render(<VoiceCameraButton api={{} as NativeVoiceApi} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Clef unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(mocks.controller.dismissCameraError).toHaveBeenCalledOnce();
  });
});
