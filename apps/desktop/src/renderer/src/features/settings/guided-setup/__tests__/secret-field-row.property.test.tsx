import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopSettingsSecretState,
  DesktopSettingsSnapshot,
} from "@pwragent/shared/contracts/settings";
import { SecretFieldRow } from "../MessagingSetupSteps";

// The secret-input rule every renderer surface follows (PR #4076): the line
// under the input states whether a value is stored, in the same words
// everywhere; the placeholder says what typing does and never claims a
// value; Remove is offered only while a value is stored, and one click never
// deletes it. These cases came over with the row from first-run setup's
// copy, minus its Finish buffer: guided setup writes every value to this
// profile's keychain when it is taken.

const SAVED = "Saved in keychain";
const UNSET = "Not set";
const PASTE = "Paste the value here";
const PASTE_REPLACE = "Paste a new value to replace it";

afterEach(cleanup);

function statusLine(input: HTMLElement): HTMLElement | null {
  for (let node = input.parentElement; node && node !== document.body; node = node.parentElement) {
    const line = node.querySelector<HTMLElement>(".settings-secret__status");
    if (line) return line;
  }
  return null;
}

/** The oracle, written out rather than imported, so the row cannot agree
 *  with itself by construction. */
function expectSecretRow(
  input: HTMLElement,
  expected: { stored: boolean; draft: boolean; removeName: string },
) {
  expect(input).toHaveAttribute("placeholder", expected.stored ? PASTE_REPLACE : PASTE);
  const line = statusLine(input);
  expect(line).not.toBeNull();
  if (expected.draft) {
    expect(line).toHaveClass("is-draft");
    expect(line!.textContent).toMatch(/^Not saved yet\./);
  } else {
    expect(line).toHaveTextContent(new RegExp(`^${expected.stored ? SAVED : UNSET}$`));
  }
  const remove = screen.queryByRole("button", { name: expected.removeName });
  expect(Boolean(remove)).toBe(expected.stored && !expected.draft);
}

function snapshotWithTelegramToken(botToken: DesktopSettingsSecretState): DesktopSettingsSnapshot {
  const unset: DesktopSettingsSecretState = { configured: false, source: "unset", writable: true };
  return {
    messaging: {
      telegram: { botToken },
      discord: { botToken: unset },
      mattermost: { botToken: unset, hmacSecret: unset },
      slack: { botToken: unset, appToken: unset, signingSecret: unset },
      feishu: { appId: unset, appSecret: unset, encryptKey: unset, verificationToken: unset },
      line: { channelAccessToken: unset, channelSecret: unset },
    },
  } as unknown as DesktopSettingsSnapshot;
}

const TOKEN_FIELD = {
  kind: "secret" as const,
  name: "telegramBotToken" as const,
  label: "Bot token",
};

const arbDraft = fc.option(fc.constantFrom("sk-fixture", "fixture-token", "x"), { nil: "" });

describe("guided setup's secret row", () => {
  it("states its stored value the way every secret input does", () => {
    fc.assert(
      fc.property(fc.boolean(), arbDraft, (stored, draft) => {
        cleanup();
        render(
          <SecretFieldRow
            field={TOKEN_FIELD}
            snapshot={snapshotWithTelegramToken({
              configured: stored,
              source: stored ? "keychain" : "unset",
              writable: true,
            })}
            replaceSecret={async () => true}
            clearSecret={async () => true}
          />,
        );
        const input = screen.getByLabelText("Bot token");
        if (draft) fireEvent.change(input, { target: { value: draft } });
        expectSecretRow(input, {
          stored,
          draft: Boolean(draft),
          removeName: "Remove saved Bot token",
        });
      }),
      { numRuns: 20 },
    );
  });

  type RemoveStep = "remove" | "confirm" | "keep";
  const arbSteps = fc.array(fc.constantFrom<RemoveStep>("remove", "confirm", "keep"), {
    minLength: 1,
    maxLength: 8,
  });

  it("waits for confirmation before removing a stored value", async () => {
    await fc.assert(
      fc.asyncProperty(arbSteps, async (steps) => {
        cleanup();
        const clearSecret = vi.fn(async () => true);
        const row = (configured: boolean) => (
          <SecretFieldRow
            field={TOKEN_FIELD}
            snapshot={snapshotWithTelegramToken({
              configured,
              source: configured ? "keychain" : "unset",
              writable: true,
            })}
            replaceSecret={async () => true}
            clearSecret={clearSecret}
          />
        );
        const view = render(row(true));
        clearSecret.mockImplementation(async () => {
          view.rerender(row(false));
          return true;
        });
        // A model with one bit: is a removal being asked.
        let asking = false;
        let confirmed = 0;
        for (const step of steps) {
          const name = step === "remove"
            ? "Remove saved Bot token"
            : step === "confirm"
              ? "Remove saved Bot token now"
              : "Keep saved Bot token";
          const button = screen.queryByRole("button", { name });
          const available = step === "remove" ? !asking && confirmed === 0 : asking;
          expect(Boolean(button)).toBe(available);
          if (!button) continue;
          await act(async () => {
            fireEvent.click(button);
          });
          if (step === "remove") asking = true;
          else {
            asking = false;
            if (step === "confirm") confirmed += 1;
          }
          expect(clearSecret.mock.calls.length).toBe(confirmed);
        }
      }),
      { numRuns: 40 },
    );
  });

  it("does not claim a keychain write that failed", async () => {
    const row = () => (
      <SecretFieldRow
        field={TOKEN_FIELD}
        snapshot={snapshotWithTelegramToken({ configured: false, source: "unset", writable: true })}
        replaceSecret={async () => false}
        clearSecret={async () => true}
      />
    );
    const view = render(row());
    const input = screen.getByLabelText("Bot token");
    expect(statusLine(input)).toHaveTextContent(/^Not set$/);
    fireEvent.change(input, { target: { value: "0000:AA-fixture" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    view.rerender(row());
    expect(screen.getByText("Could not save this value — try again.")).toBeInTheDocument();
    // The value stays in the box to retry, as a draft, not as a write.
    expect(statusLine(input)).toHaveClass("is-draft");
    expect(statusLine(input)).not.toHaveTextContent(/New value saved/);
    // Cleared, nothing claims a value was kept anywhere.
    fireEvent.change(input, { target: { value: "" } });
    expect(statusLine(input)).toHaveTextContent(/^Not set$/);
  });

  it("removes a value it just wrote, before the snapshot reports it", async () => {
    const clearSecret = vi.fn(async () => true);
    const replaceSecret = vi.fn(async () => true);
    render(
      <SecretFieldRow
        field={TOKEN_FIELD}
        snapshot={snapshotWithTelegramToken({ configured: false, source: "unset", writable: true })}
        replaceSecret={replaceSecret}
        clearSecret={clearSecret}
      />,
    );
    const input = screen.getByLabelText("Bot token");
    // A pasted token often brings a newline; what is stored is trimmed.
    fireEvent.change(input, { target: { value: "0000:AA-fixture\n" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(replaceSecret).toHaveBeenCalledWith("telegramBotToken", "0000:AA-fixture");
    expect(input).toHaveValue("");
    expect(statusLine(input)).toHaveTextContent("New value saved in keychain");
    fireEvent.click(screen.getByRole("button", { name: "Remove saved Bot token" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove saved Bot token now" }));
    });
    expect(clearSecret).toHaveBeenCalledWith("telegramBotToken");
  });
});
