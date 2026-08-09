import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CELESTIAL_ICON_IDS } from "@pwragent/shared";
import {
  CelestialBlackHoleIcon,
  CelestialIcon,
  CelestialMoonIcon,
  CelestialRingedPlanetIcon,
  CelestialSunIcon,
  CelestialTiltedRingedPlanetIcon,
  StarMapIcon,
} from "../index";

afterEach(() => {
  cleanup();
});

const CELESTIAL_ICONS = [
  ["CelestialSunIcon", CelestialSunIcon],
  ["CelestialMoonIcon", CelestialMoonIcon],
  ["CelestialRingedPlanetIcon", CelestialRingedPlanetIcon],
  ["CelestialTiltedRingedPlanetIcon", CelestialTiltedRingedPlanetIcon],
  ["CelestialBlackHoleIcon", CelestialBlackHoleIcon],
] as const;

// The celestial set must stay themeable: color comes exclusively from
// currentColor plus numeric opacity attributes. Any literal color or
// gradient reference in the markup is a regression.
const COLOR_LITERAL_RE = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|url\(#/;

describe("celestial icon library", () => {
  it.each(CELESTIAL_ICONS)(
    "%s honors the shared filled-icon and accessibility contracts",
    (_name, Icon) => {
      const { container, rerender } = render(<Icon />);
      const svg = container.querySelector("svg");
      expect(svg).toBeInTheDocument();
      expect(svg).toHaveAttribute("width", "16");
      expect(svg).toHaveAttribute("height", "16");
      expect(svg).toHaveAttribute("viewBox", "0 0 24 24");
      // Filled icons paint per-element — the root must not carry the
      // stroke-icon fill="none" default.
      expect(svg).not.toHaveAttribute("fill");
      // Decorative by default — no aria-label means hidden from AT.
      expect(svg).toHaveAttribute("aria-hidden", "true");
      expect(container.innerHTML).not.toMatch(COLOR_LITERAL_RE);

      rerender(<Icon aria-label="Instance icon" />);
      const labelledSvg = container.querySelector("svg");
      expect(labelledSvg).toHaveAttribute("role", "img");
      expect(labelledSvg).toHaveAttribute("aria-label", "Instance icon");
      expect(labelledSvg).toHaveAttribute("aria-hidden", "false");
    },
  );

  it("renders five pairwise-distinct silhouettes", () => {
    const markups = new Set<string>();
    for (const [, Icon] of CELESTIAL_ICONS) {
      const { container } = render(<Icon />);
      markups.add(container.innerHTML);
      cleanup();
    }
    expect(markups.size).toBe(CELESTIAL_ICONS.length);
  });

  it("respects size overrides", () => {
    const { container } = render(<CelestialMoonIcon size={48} />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("width", "48");
    expect(svg).toHaveAttribute("height", "48");
  });

  describe("CelestialIcon dispatcher", () => {
    it("renders a distinct SVG for every id", () => {
      const markups = new Set<string>();
      for (const icon of CELESTIAL_ICON_IDS) {
        const { container } = render(<CelestialIcon icon={icon} />);
        const svg = container.querySelector("svg");
        expect({
          icon,
          rendered: svg !== null,
          viewBox: svg?.getAttribute("viewBox"),
        }).toEqual({
          icon,
          rendered: true,
          viewBox: "0 0 24 24",
        });
        markups.add(container.innerHTML);
        cleanup();
      }
      expect(markups.size).toBe(CELESTIAL_ICON_IDS.length);
    });
  });

  describe("StarMapIcon", () => {
    it("renders a stroke icon with the shared defaults", () => {
      const { container } = render(<StarMapIcon />);
      const svg = container.querySelector("svg");
      expect(svg).toBeInTheDocument();
      expect(svg).toHaveAttribute("viewBox", "0 0 24 24");
      expect(svg).toHaveAttribute("stroke", "currentColor");
      expect(svg).toHaveAttribute("aria-hidden", "true");
      expect(container.innerHTML).not.toMatch(COLOR_LITERAL_RE);
    });
  });
});
