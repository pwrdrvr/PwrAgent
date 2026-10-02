import { afterEach, describe, expect, it } from "vitest";
import { applyAppearanceAttributes, readBridgedAppearance } from "../appearance";

type BridgedWindow = Window & { __pwragentAppearance?: unknown };

afterEach(() => {
  const root = document.documentElement;
  for (const attribute of [
    "data-theme",
    "data-palette",
    "data-density",
    "data-sidebar-text",
    "data-transcript-text",
  ]) {
    root.removeAttribute(attribute);
  }
  delete (window as BridgedWindow).__pwragentAppearance;
});

describe("applyAppearanceAttributes", () => {
  it("keeps data-theme as the scheme and recolors through data-palette", () => {
    const root = document.documentElement;

    applyAppearanceAttributes("light", "catppuccin", "mission-control", "md", "md");
    expect(root.dataset.theme).toBe("light");
    expect(root.dataset.palette).toBe("catppuccin");

    applyAppearanceAttributes("dark", "catppuccin", "mission-control", "md", "md");
    expect(root.hasAttribute("data-theme")).toBe(false);
    expect(root.dataset.palette).toBe("catppuccin");

    // Tangerine is the bare :root, so the attribute goes away.
    applyAppearanceAttributes("dark", "tangerine", "mission-control", "md", "md");
    expect(root.hasAttribute("data-palette")).toBe(false);
  });
});

describe("readBridgedAppearance", () => {
  it("reads a bridged palette and falls back to Tangerine on anything else", () => {
    (window as BridgedWindow).__pwragentAppearance = { palette: "catppuccin" };
    expect(readBridgedAppearance().palette).toBe("catppuccin");

    (window as BridgedWindow).__pwragentAppearance = { palette: "dracula" };
    expect(readBridgedAppearance().palette).toBe("tangerine");

    delete (window as BridgedWindow).__pwragentAppearance;
    expect(readBridgedAppearance().palette).toBe("tangerine");
  });
});
