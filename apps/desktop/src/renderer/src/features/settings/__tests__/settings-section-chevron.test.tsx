import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsSection } from "../SettingsLayout";

afterEach(cleanup);

describe("settings section disclosure chevron placement", () => {
  it("renders the chevron as the first child of the header, before the title block", () => {
    const { container } = render(
      <SettingsSection title="Telegram">
        <div>body</div>
      </SettingsSection>,
    );

    const header = container.querySelector(".settings-section__header-button");
    expect(header).not.toBeNull();

    const children = [...(header as HTMLElement).children];
    expect(children[0]).toHaveClass("settings-section__chevron");
    expect(children[1]).toHaveClass("settings-section__header-main");
  });

  it("no longer renders the chevron inside the right-side header actions", () => {
    const { container } = render(
      <SettingsSection title="Telegram">
        <div>body</div>
      </SettingsSection>,
    );

    const actions = container.querySelector(
      ".settings-section__header-actions",
    );
    expect(actions?.querySelector(".settings-section__chevron")).toBeNull();
  });
});
