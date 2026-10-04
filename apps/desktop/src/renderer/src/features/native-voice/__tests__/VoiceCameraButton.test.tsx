import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeVoiceController, VoiceCameraDiagnostics, VoiceView } from "../native-voice-controller";
import { cameraCueLabel, cameraDiagnosticsText, VoiceCameraButton, VoiceCameraDock } from "../VoiceCameraButton";

const controller = { setCamera: vi.fn(), cameraStream: vi.fn(), dismissCameraError: vi.fn() } as unknown as NativeVoiceController;
let view: VoiceView;

function diagnostics(change: Partial<VoiceCameraDiagnostics> = {}): VoiceCameraDiagnostics {
  return {
    sessionId: "sample-session", threadId: "sample-director", startedAt: Date.now(), observations: 8,
    staleObservations: 1, rateHz: 2.2, lastObservedAt: Date.now(), frameAgeMs: 410,
    filter: "Collecting consecutive frames", cuesAcknowledged: 0,
    observation: {
      present: true, presenceConfidence: 0.98, reaction: "talking", reactionConfidence: 0.78, latencyMs: 570,
      presenceScores: { present: 0.98, away: 0.02 },
      reactionScores: { neutral: 0.16, exasperated: 0.03, frustrated: 0.02, yelling: 0.01, talking: 0.78 },
      gesture: "none", gestureConfidence: 0.81,
      gestureScores: { pointing: 0.06, ok: 0.01, stop: 0.04, thumbs_up: 0.05, double_thumbs_up: 0.01, thumbs_down: 0.01, face_palm: 0.01, none: 0.81 },
    },
    ...change,
  };
}

beforeEach(() => {
  view = { status: "listening", muted: false, transcript: [], actions: [] };
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  window.localStorage.clear();
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

  it("keeps opt-out available during permission and warmup waiting, with the preview in the dock", () => {
    view.camera = "starting";
    const result = render(<><VoiceCameraButton controller={controller} view={view} /><VoiceCameraDock controller={controller} view={view} /></>);
    fireEvent.click(screen.getByRole("button", { name: "Turn off camera cues" }));
    expect(controller.setCamera).toHaveBeenCalledWith(false);
    expect(screen.getByRole("status")).toHaveTextContent("Starting camera");
    result.rerender(<VoiceCameraDock controller={controller} view={{ ...view, camera: "on", cameraWarming: true }} />);
    expect(screen.getByLabelText("Camera preview").tagName).toBe("VIDEO");
    expect(screen.getByRole("status")).toHaveTextContent("warming up");
    // No pick is shown for a frame the cold model has not judged.
    expect(screen.getByRole("region", { name: "Camera cues" })).not.toHaveTextContent("talking");
  });

  it("reads each question's top pick with the model's speed, and quiets an idle pick", () => {
    render(<VoiceCameraDock controller={controller} view={{ ...view, camera: "on", cameraDiagnostics: diagnostics() }} />);
    const dock = screen.getByRole("region", { name: "Camera cues" });
    expect(dock).toHaveTextContent("570 ms");
    expect(dock).toHaveTextContent("2.2 /s");
    const reads = dock.querySelectorAll(".voice-camera-dock__read");
    expect([...reads].map((row) => row.textContent)).toEqual(["gesturenone81%", "vibetalking78%", "presentyes98%"]);
    expect(reads[0]).toHaveClass("voice-camera-dock__read--idle");
    expect(reads[1]).not.toHaveClass("voice-camera-dock__read--idle");
  });

  it("marks the row whose cue was just delivered", () => {
    const debug = diagnostics({ delivery: "acknowledged", lastCue: "stop", acknowledgedAt: Date.now(), cuesAcknowledged: 1 });
    debug.observation = { ...debug.observation!, gesture: "stop", gestureConfidence: 0.91 };
    render(<VoiceCameraDock controller={controller} view={{ ...view, camera: "on", cameraDiagnostics: debug }} />);
    const gesture = screen.getByRole("region", { name: "Camera cues" }).querySelector(".voice-camera-dock__read")!;
    expect(gesture).toHaveClass("voice-camera-dock__read--sent");
    expect(gesture).toHaveTextContent("gesturestopsent");
  });

  it("expands to every option's score, remembers it, and copies the diagnostics it leaves off-screen", () => {
    const onCopy = vi.fn();
    const result = render(<VoiceCameraDock controller={controller} onCopyDiagnostics={onCopy} view={{ ...view, camera: "on", cameraDiagnostics: diagnostics() }} />);
    fireEvent.click(screen.getByRole("button", { name: "Show all camera scores" }));
    const dock = screen.getByRole("region", { name: "Camera cues" });
    const cards = dock.querySelectorAll(".voice-camera-dock__card");
    expect(cards).toHaveLength(3);
    expect(within(cards[1] as HTMLElement).getByText("talking", { selector: ".voice-camera-dock__option span" }).parentElement)
      .toHaveClass("voice-camera-dock__option--selected");
    expect(cards[1]).toHaveTextContent("neutral16%");
    expect(cards[0]).toHaveTextContent("two thumbs up1%");
    expect(dock).toHaveTextContent("Collecting consecutive frames");
    fireEvent.click(screen.getByRole("button", { name: "Copy camera diagnostics" }));
    expect(onCopy.mock.calls[0][0]).toContain("Session: sample-session");
    // A later session opens the way the operator left it.
    result.unmount();
    render(<VoiceCameraDock controller={controller} view={{ ...view, camera: "on", cameraDiagnostics: diagnostics() }} />);
    expect(screen.getByRole("button", { name: "Show top camera picks" })).toHaveAttribute("aria-expanded", "true");
  });

  it("leaves with the camera, but keeps a failure visible and dismissible", () => {
    const result = render(<VoiceCameraDock controller={controller} view={view} />);
    expect(result.container).toBeEmptyDOMElement();
    result.rerender(<VoiceCameraDock controller={controller} view={{ ...view, cameraError: "Clef unavailable" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Clef unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(controller.dismissCameraError).toHaveBeenCalledOnce();
  });

  it("names cues the way the operator would say them", () => {
    expect(cameraCueLabel("double_thumbs_up")).toBe("two thumbs up");
    expect(cameraCueLabel("face_palm")).toBe("face palm");
    expect(cameraCueLabel("frustrated")).toBe("frustrated");
    expect(cameraDiagnosticsText(diagnostics(), Date.now())).toContain("vibe: exasperated 3%, frustrated 2%, yelling 1%, talking 78%, neutral 16%");
  });
});
