import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { NativeVoiceApi, NativeVoiceCapability } from "../../../../../shared/native-voice";
import { NativeVoice } from "../NativeVoice";

afterEach(cleanup);

it("keeps the idle hint separate from coding status and announces opted-in voice state", async () => {
  let resolveCapability!: (value: NativeVoiceCapability) => void;
  const capability = new Promise<NativeVoiceCapability>((resolve) => { resolveCapability = resolve; });
  const api: NativeVoiceApi = {
    nativeVoiceCapability: vi.fn(() => capability),
    startNativeVoice: vi.fn(async () => {}),
    stopNativeVoice: vi.fn(async () => {}),
    sendNativeVoiceText: vi.fn(async () => {}),
    onNativeVoiceEvent: vi.fn(() => () => {}),
  };
  render(<><div role="status">Thinking</div><NativeVoice api={api} threadId="sample-thread" /></>);
  expect(screen.getByRole("status")).toHaveTextContent("Thinking");
  expect(screen.getByText("Experimental · opt in to talk")).not.toHaveAttribute("role");
  expect(api.nativeVoiceCapability).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Start voice" }));
  expect(await screen.findByRole("status", { name: "Voice status" })).toHaveTextContent("Checking voice access");
  resolveCapability({ available: false, reason: "Unsupported sample runtime." });
  expect(await screen.findByRole("alert")).toHaveTextContent("Unsupported sample runtime.");
  expect(api.startNativeVoice).not.toHaveBeenCalled();
});
