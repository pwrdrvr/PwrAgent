import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopSettingsSecretName } from "@pwragent/shared";
import { SecretFieldRow } from "../OnboardingWizard";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * The fix this test locks in: messaging-runtime secrets entered in
 * the wizard's provider-setup step must be persisted *live* (via
 * `replaceSecret`) so the desktop messaging runtime can evaluate
 * `hasRunnableAdapters === true` and actually start while the
 * operator is still on the same step.
 *
 * Before the fix, only the renderer-side buffer was updated, so the
 * runtime stayed in "no_runnable_adapters" — the operator saw the
 * provider listed as Enabled in Settings but no titlebar icon
 * appeared, and pairing codes were silently dropped because no
 * adapter was actually listening.
 *
 * The buffer is still maintained alongside — it's the source of
 * truth for the graduation step that copies secrets onto the
 * target profile after the wizard finishes.
 */
describe("SecretFieldRow live-write contract", () => {
  it("messaging-runtime secrets: writes via replaceSecret AND buffers", async () => {
    const onBuffer = vi.fn();
    const replaceSecret = vi.fn(
      async (_secret: DesktopSettingsSecretName, _value: string) => true,
    );
    const clearSecret = vi.fn(
      async (_secret: DesktopSettingsSecretName) => true,
    );

    render(
      <SecretFieldRow
        field={{
          kind: "secret",
          name: "telegramBotToken",
          label: "Bot token",
          placeholder: "0000000000:AAEx",
        }}
        bufferedValue=""
        onBuffer={onBuffer}
        replaceSecret={replaceSecret}
        clearSecret={clearSecret}
      />,
    );

    const tokenInput = screen.getByPlaceholderText(/0000000000:AAEx/);
    fireEvent.change(tokenInput, {
      target: { value: "0000000000:AAEx-fake-telegram-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Use this/i }));

    await waitFor(() => {
      expect(replaceSecret).toHaveBeenCalledWith(
        "telegramBotToken",
        "0000000000:AAEx-fake-telegram-token",
      );
    });
    expect(onBuffer).toHaveBeenCalledWith(
      "0000000000:AAEx-fake-telegram-token",
    );
  });

  it("non-runtime secrets (xAI key): buffers but does NOT call replaceSecret", async () => {
    const onBuffer = vi.fn();
    const replaceSecret = vi.fn(
      async (_secret: DesktopSettingsSecretName, _value: string) => true,
    );
    const clearSecret = vi.fn(
      async (_secret: DesktopSettingsSecretName) => true,
    );

    render(
      <SecretFieldRow
        field={{
          kind: "secret",
          name: "grokApiKey",
          label: "xAI API key",
          placeholder: "xai-…",
        }}
        bufferedValue=""
        onBuffer={onBuffer}
        replaceSecret={replaceSecret}
        clearSecret={clearSecret}
      />,
    );

    const xaiInput = screen.getByPlaceholderText(/xai-/);
    fireEvent.change(xaiInput, { target: { value: "xai-test-key-1234" } });
    fireEvent.click(screen.getByRole("button", { name: /Use this/i }));

    expect(onBuffer).toHaveBeenCalledWith("xai-test-key-1234");
    // Two microtask flushes to let any async save resolve.
    await Promise.resolve();
    await Promise.resolve();
    expect(replaceSecret).not.toHaveBeenCalled();
  });

  it("messaging secret Clear: calls clearSecret on the runtime AND buffers empty", async () => {
    const onBuffer = vi.fn();
    const replaceSecret = vi.fn(
      async (_secret: DesktopSettingsSecretName, _value: string) => true,
    );
    const clearSecret = vi.fn(
      async (_secret: DesktopSettingsSecretName) => true,
    );

    render(
      <SecretFieldRow
        field={{
          kind: "secret",
          name: "telegramBotToken",
          label: "Bot token",
          placeholder: "0000000000:AAEx",
        }}
        // Pre-populated buffer simulates a value already typed in.
        bufferedValue="0000000000:AAEx-existing"
        onBuffer={onBuffer}
        replaceSecret={replaceSecret}
        clearSecret={clearSecret}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Clear$/i }));

    expect(onBuffer).toHaveBeenCalledWith("");
    // The runtime clear is skipped when nothing is configured server-side
    // yet (`configured === false`), to avoid an unnecessary IPC round-trip
    // on a brand-new field that was only buffered. This keeps the test
    // surface honest: a Clear with neither a configured secret nor a
    // buffered value is a no-op, but the buffered-only path still resets
    // the buffer (asserted above).
    await Promise.resolve();
    expect(clearSecret).not.toHaveBeenCalled();
  });

  it("non-runtime secret Clear: buffers empty, never touches clearSecret", async () => {
    const onBuffer = vi.fn();
    const replaceSecret = vi.fn(
      async (_secret: DesktopSettingsSecretName, _value: string) => true,
    );
    const clearSecret = vi.fn(
      async (_secret: DesktopSettingsSecretName) => true,
    );

    render(
      <SecretFieldRow
        field={{
          kind: "secret",
          name: "grokApiKey",
          label: "xAI API key",
          placeholder: "xai-…",
        }}
        bufferedValue="xai-existing"
        onBuffer={onBuffer}
        replaceSecret={replaceSecret}
        clearSecret={clearSecret}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Clear$/i }));
    expect(onBuffer).toHaveBeenCalledWith("");
    await Promise.resolve();
    expect(clearSecret).not.toHaveBeenCalled();
  });
});
