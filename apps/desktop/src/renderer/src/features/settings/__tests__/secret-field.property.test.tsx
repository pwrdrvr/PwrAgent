import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import type { DesktopSettingsSecretState } from "@pwragent/shared/contracts/settings";
import { SecretField } from "../SecretField";
import { describeSecretField } from "../secret-field-state";

// The rule: a secret's row states whether a value is stored, in the control
// itself, and nothing in an empty row looks like a stored value. Operators
// could not tell a set key from an unset one: both drew bullets in the box,
// and the only difference was a 10px pill under the description.

const arbState = fc.record({
  configured: fc.boolean(),
  source: fc.constantFrom("unset", "keychain", "env"),
  writable: fc.boolean(),
  overriddenByEnv: fc.option(fc.boolean(), { nil: undefined }),
}) as fc.Arbitrary<DesktopSettingsSecretState>;

const arbRow = fc.record({ dirty: fc.boolean(), saved: fc.boolean() });

function renderField(state: DesktopSettingsSecretState) {
  const view = render(
    <SecretField
      label="Fixture key"
      secret="telegramBotToken"
      state={state}
      onClearSecret={async () => true}
      onReplaceSecret={async () => true}
    />,
  );
  const input = screen.getByLabelText("Fixture key");
  const row = input.closest(".settings-secret") as HTMLElement;
  return { view, input, row };
}

describe("describeSecretField", () => {
  it("never draws a placeholder that looks like a stored value", () => {
    fc.assert(
      fc.property(arbState, arbRow, (state, row) => {
        expect(describeSecretField(state, row).placeholder).not.toMatch(/[•●*]/);
      }),
    );
  });

  it("says a value is stored exactly when one is", () => {
    fc.assert(
      fc.property(arbState, fc.boolean(), (state, saved) => {
        const view = describeSecretField(state, { dirty: false, saved });
        const stored = state.configured || saved || state.source === "env";
        expect(view.tone === "unset").toBe(!stored);
        expect(view.status === "Not set").toBe(!stored);
      }),
    );
  });

  it("answers a write with words the row did not show before it", () => {
    fc.assert(
      fc.property(arbState, (state) => {
        const before = describeSecretField(state, { dirty: false, saved: false });
        const after = describeSecretField(state, { dirty: false, saved: true });
        expect(after.status).not.toBe(before.status);
        expect(after.status).toContain("aved in keychain");
      }),
    );
  });

  it("offers Remove only for a stored value this row can remove", () => {
    fc.assert(
      fc.property(arbState, arbRow, (state, row) => {
        const view = describeSecretField(state, row);
        const removable = (state.configured || row.saved) && state.source !== "env";
        expect(view.canRemove).toBe(removable);
        expect(view.commitLabel).toBe(removable ? "Replace" : "Save");
      }),
    );
  });

  it("makes a waiting draft the row's primary action and names how to save it", () => {
    fc.assert(
      fc.property(arbState, fc.boolean(), (state, saved) => {
        const draft = describeSecretField(state, { dirty: true, saved });
        expect(draft.tone).toBe("draft");
        expect(draft.commitIsPrimary).toBe(true);
        expect(draft.status).toContain(`Press Enter or ${draft.commitLabel}`);
        const rest = describeSecretField(state, { dirty: false, saved });
        expect(rest.commitIsPrimary).toBe(false);
        expect(rest.status).not.toContain("Not saved yet");
      }),
    );
  });
});

describe("SecretField", () => {
  afterEach(cleanup);

  const stored: DesktopSettingsSecretState = {
    configured: true,
    source: "keychain",
    writable: true,
  };

  function field(state: DesktopSettingsSecretState) {
    return (
      <SecretField
        label="Fixture key"
        secret="telegramBotToken"
        state={state}
        onClearSecret={async () => true}
        onReplaceSecret={async () => true}
      />
    );
  }

  it("reads differently after replacing a stored value, in a new live region", async () => {
    const { input, row } = renderField(stored);
    const before = within(row).getByText("Saved in keychain");

    fireEvent.change(input, { target: { value: "fixture-value" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const after = await within(row).findByText("New value saved in keychain");
    expect(after).toHaveAttribute("role", "status");
    expect(after).not.toBe(before);
  });

  it("stops vouching for its own write once the store reports the value gone", async () => {
    const view = render(field(stored));
    const input = screen.getByLabelText("Fixture key");
    const row = input.closest(".settings-secret") as HTMLElement;
    fireEvent.change(input, { target: { value: "fixture-value" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await within(row).findByText("New value saved in keychain");

    view.rerender(field({ configured: false, source: "unset", writable: true }));

    expect(within(row).getByText("Not set")).toBeInTheDocument();
    expect(
      within(row).queryByRole("button", { name: "Remove saved Fixture key" }),
    ).toBeNull();
  });

  it("does not ask for a save that whitespace alone cannot make", () => {
    const { input, row } = renderField({
      configured: false,
      source: "unset",
      writable: true,
    });

    fireEvent.change(input, { target: { value: "   " } });

    expect(within(row).getByText("Not set")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Save" })).not.toHaveClass(
      "button--primary",
    );
    expect(within(row).getByRole("button", { name: "Discard" })).toBeInTheDocument();
  });

  it("states the stored state inside the control, for every state", () => {
    fc.assert(
      fc.property(arbState, (state) => {
        const { view, input, row } = renderField(state);
        try {
          const expected = describeSecretField(state, { dirty: false, saved: false });
          expect(within(row).getByText(expected.status)).toBeInTheDocument();
          expect(input).toHaveAttribute("placeholder", expected.placeholder);
          expect(
            within(row).queryByRole("button", { name: "Remove saved Fixture key" })
              !== null,
          ).toBe(expected.canRemove);
        } finally {
          view.unmount();
        }
      }),
      { numRuns: 40 },
    );
  });

  it("turns Save primary and explains itself once a value is typed", () => {
    const { input, row } = renderField({
      configured: false,
      source: "unset",
      writable: true,
    });
    const save = within(row).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    expect(save).not.toHaveClass("button--primary");

    fireEvent.change(input, { target: { value: "fixture-value" } });

    expect(save).toBeEnabled();
    expect(save).toHaveClass("button--primary");
    expect(
      within(row).getByText("Not saved yet. Press Enter or Save."),
    ).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Discard" })).toBeInTheDocument();
  });
});
