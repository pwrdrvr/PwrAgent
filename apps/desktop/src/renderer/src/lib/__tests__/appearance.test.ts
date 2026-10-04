import { afterEach, describe, expect, it } from "vitest";
import {
  applyAppearanceAttributes,
  readBridgedAppearance,
  resolveColorTheme,
} from "../appearance";

type BridgedWindow = Window & { __pwragentAppearance?: unknown };

afterEach(() => {
  const root = document.documentElement;
  for (const attribute of [
    "data-theme",
    "data-color-theme",
    "data-density",
    "data-sidebar-text",
    "data-transcript-text",
  ]) {
    root.removeAttribute(attribute);
  }
  delete (window as BridgedWindow).__pwragentAppearance;
});

describe("resolveColorTheme", () => {
  it("picks the light theme in the light scheme and the dark theme otherwise", () => {
    expect(resolveColorTheme("light", "solarized-dark", "blue-light")).toBe("blue-light");
    expect(resolveColorTheme("dark", "solarized-dark", "blue-light")).toBe("solarized-dark");
  });
});

describe("applyAppearanceAttributes", () => {
  it("keeps data-theme as the scheme and recolors through data-color-theme", () => {
    const root = document.documentElement;

    applyAppearanceAttributes(
      "light",
      "gray-dark",
      "catppuccin-latte",
      "mission-control",
      "md",
      "md",
    );
    expect(root.dataset.theme).toBe("light");
    expect(root.dataset.colorTheme).toBe("catppuccin-latte");

    applyAppearanceAttributes(
      "dark",
      "gray-dark",
      "catppuccin-latte",
      "mission-control",
      "md",
      "md",
    );
    expect(root.hasAttribute("data-theme")).toBe(false);
    expect(root.dataset.colorTheme).toBe("gray-dark");

    // Tangerine is the bare :root pair, so the attribute goes away.
    applyAppearanceAttributes(
      "dark",
      "tangerine-dark",
      "catppuccin-latte",
      "mission-control",
      "md",
      "md",
    );
    expect(root.hasAttribute("data-color-theme")).toBe(false);
    applyAppearanceAttributes(
      "light",
      "gray-dark",
      "tangerine-light",
      "mission-control",
      "md",
      "md",
    );
    expect(root.hasAttribute("data-color-theme")).toBe(false);
  });
});

describe("readBridgedAppearance", () => {
  it("reads bridged themes and falls back to Tangerine on anything else", () => {
    (window as BridgedWindow).__pwragentAppearance = {
      darkTheme: "solarized-dark",
      lightTheme: "blue-light",
    };
    expect(readBridgedAppearance()).toMatchObject({
      darkTheme: "solarized-dark",
      lightTheme: "blue-light",
    });

    // A dark theme in the light slot (or the reverse) is not a valid choice.
    (window as BridgedWindow).__pwragentAppearance = {
      darkTheme: "solarized-light",
      lightTheme: "dracula",
    };
    expect(readBridgedAppearance()).toMatchObject({
      darkTheme: "tangerine-dark",
      lightTheme: "tangerine-light",
    });
  });
});
