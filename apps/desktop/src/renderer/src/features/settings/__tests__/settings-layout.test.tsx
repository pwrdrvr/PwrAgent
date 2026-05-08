import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
} from "../SettingsLayout";

afterEach(() => {
  cleanup();
});

let paneIndex = 0;

function renderSectionStack(paneId = `test-pane-${paneIndex++}`) {
  return render(
    <SettingsSectionStack paneId={paneId} aria-label="Test settings">
      <SettingsPanelHead
        eyebrow="Test"
        title="Settings"
        help="A compact test pane."
      />
      <SettingsSection eyebrow="Test" title="Alpha">
        <button type="button">Alpha action</button>
      </SettingsSection>
      <SettingsSection eyebrow="Test" title="Beta">
        <button type="button">Beta action</button>
      </SettingsSection>
    </SettingsSectionStack>,
  );
}

describe("SettingsLayout", () => {
  it("collapses and expands sections from the header", async () => {
    renderSectionStack("collapse-pane");

    const alpha = screen.getByRole("button", { name: "Alpha" });
    expect(alpha).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Alpha action" })).toBeEnabled();

    fireEvent.click(alpha);

    expect(alpha).toHaveAttribute("aria-expanded", "false");
    const body = document.querySelector("#settings-section-collapse-pane-alpha-body");
    expect(body).toHaveAttribute("aria-hidden", "true");
    expect(body).toHaveAttribute("inert");

    fireEvent.click(alpha);

    expect(alpha).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => {
      expect(body).toHaveAttribute("aria-hidden", "false");
    });
    expect(body).not.toHaveAttribute("inert");
  });

  it("supports collapse all and expand all at the pane top", async () => {
    renderSectionStack();

    const collapseAll = await screen.findByRole("button", {
      name: "Collapse all",
    });
    const expandAll = screen.getByRole("button", { name: "Expand all" });

    expect(collapseAll).toBeEnabled();
    expect(expandAll).toBeDisabled();

    fireEvent.click(collapseAll);

    expect(screen.getByRole("button", { name: "Alpha" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: "Beta" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(collapseAll).toBeDisabled();
    expect(expandAll).toBeEnabled();

    fireEvent.click(expandAll);

    expect(screen.getByRole("button", { name: "Alpha" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("button", { name: "Beta" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("handles keyboard activation and section-header focus movement", () => {
    renderSectionStack();

    const alpha = screen.getByRole("button", { name: "Alpha" });
    const beta = screen.getByRole("button", { name: "Beta" });

    alpha.focus();
    fireEvent.keyDown(alpha, { key: " " });
    expect(alpha).toHaveAttribute("aria-expanded", "false");

    fireEvent.keyDown(alpha, { key: "Enter" });
    expect(alpha).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(alpha, { key: "ArrowDown" });
    expect(beta).toHaveFocus();

    fireEvent.keyDown(beta, { key: "ArrowUp" });
    expect(alpha).toHaveFocus();

    fireEvent.keyDown(alpha, { key: "End" });
    expect(beta).toHaveFocus();

    fireEvent.keyDown(beta, { key: "Home" });
    expect(alpha).toHaveFocus();
  });

  it("persists collapsed state and restores focus within the session", async () => {
    const paneId = `persistent-pane-${paneIndex++}`;
    const firstRender = renderSectionStack(paneId);

    fireEvent.click(await screen.findByRole("button", { name: "Collapse all" }));
    fireEvent.click(screen.getByRole("button", { name: "Beta" }));

    expect(screen.getByRole("button", { name: "Alpha" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: "Beta" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    firstRender.unmount();
    renderSectionStack(paneId);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Beta" })).toHaveFocus();
    });
    expect(screen.getByRole("button", { name: "Alpha" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: "Beta" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});
