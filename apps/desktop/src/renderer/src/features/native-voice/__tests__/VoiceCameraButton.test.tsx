import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeVoiceController, VoiceView } from "../native-voice-controller";
import { VoiceCameraButton, VoiceCameraPanel } from "../VoiceCameraButton";

const controller = { setCamera: vi.fn(), cameraStream: vi.fn(), dismissCameraError: vi.fn() } as unknown as NativeVoiceController;
let view: VoiceView;
beforeEach(() => {
  view = { status: "listening", muted: false, transcript: [], actions: [] };
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); });
describe("camera voice control", () => {
  it("shows only during live voice and requests explicit opt-in on click", () => {
    const result = render(<VoiceCameraButton controller={controller} view={view} />);
    fireEvent.click(screen.getByRole("button", { name: "Turn on camera cues" }));
    expect(controller.setCamera).toHaveBeenCalledWith(true);
    result.rerender(<VoiceCameraButton controller={controller} view={{ ...view, status: "idle" }} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
  it("keeps opt-out available during permission and warmup waiting, with an inline preview", () => {
    view.camera = "starting";
    const result = render(<><VoiceCameraButton controller={controller} view={view} /><VoiceCameraPanel controller={controller} view={view} /></>);
    fireEvent.click(screen.getByRole("button", { name: "Turn off camera cues" }));
    expect(controller.setCamera).toHaveBeenCalledWith(false);
    expect(screen.getByRole("status")).toHaveTextContent("Starting camera");
    result.rerender(<VoiceCameraPanel controller={controller} view={{ ...view, camera: "on", cameraWarming: true }} />);
    expect(result.container.querySelector("video")).not.toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("warming up");
  });
  it("shows all scores and separates received observations from acknowledged voice context", () => {
    view.camera = "on";
    view.cameraDiagnostics = {
      sessionId: "sample-session", threadId: "sample-director", startedAt: Date.now(), observations: 8,
      staleObservations: 1, rateHz: 1.7, lastObservedAt: Date.now(), frameAgeMs: 410,
      filter: "Collecting consecutive frames", cuesAcknowledged: 0,
      observation: { present: true, presenceConfidence: 0.95, reaction: "neutral", reactionConfidence: 0.8, latencyMs: 400,
        presenceScores: { present: 0.95, away: 0.05 }, reactionScores: { neutral: 0.8, exasperated: 0.05, enthusiastic: 0.1, bored: 0.05 } },
    };
    const result = render(<VoiceCameraPanel controller={controller} view={view} />);
    const summary = screen.getByText(/Camera diagnostics/);
    expect(summary).toHaveTextContent("8 results · 1.70 Hz");
    expect(summary.parentElement).not.toHaveAttribute("open");
    fireEvent.click(summary);
    expect(summary.parentElement).toHaveAttribute("open");
    expect(screen.getByRole("table")).toHaveTextContent("neutral · selected80.0%");
    expect(screen.getByRole("table")).toHaveTextContent("enthusiastic10.0%");
    expect(screen.getAllByText(/No voice context sent yet/)).toHaveLength(2);
    result.rerender(<VoiceCameraPanel controller={controller} view={{ ...view, cameraDiagnostics: { ...view.cameraDiagnostics, delivery: "acknowledged", lastCue: "neutral", cuesAcknowledged: 1 } }} />);
    expect(screen.getAllByText(/Voice context acknowledged · neutral/)).toHaveLength(2);
    expect(screen.getByText(/does not prove the model used the cue/)).toBeInTheDocument();
  });
  it("keeps camera failures visible and dismissible without hiding the receipt", () => {
    render(<VoiceCameraPanel controller={controller} view={{ ...view, cameraError: "Clef unavailable" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Clef unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(controller.dismissCameraError).toHaveBeenCalledOnce();
  });
});
