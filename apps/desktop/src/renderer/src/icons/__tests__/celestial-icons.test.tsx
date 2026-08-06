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
    "%s renders an SVG with the shared filled-icon defaults",
    (_name, Icon) => {
      const { container } = render(<Icon />);
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
    },
  );

  it.each(CELESTIAL_ICONS)(
    "%s switches to role=img when an aria-label is supplied",
    (_name, Icon) => {
      const { container } = render(<Icon aria-label="Instance icon" />);
      const svg = container.querySelector("svg");
      expect(svg).toHaveAttribute("role", "img");
      expect(svg).toHaveAttribute("aria-label", "Instance icon");
      expect(svg).toHaveAttribute("aria-hidden", "false");
    },
  );

  it.each(CELESTIAL_ICONS)(
    "%s contains no color literals (currentColor + opacity only)",
    (_name, Icon) => {
      const { container } = render(<Icon />);
      expect(container.innerHTML).not.toMatch(COLOR_LITERAL_RE);
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
    it.each(CELESTIAL_ICON_IDS)("renders an SVG for id %s", (icon) => {
      const { container } = render(<CelestialIcon icon={icon} />);
      const svg = container.querySelector("svg");
      expect(svg).toBeInTheDocument();
      expect(svg).toHaveAttribute("viewBox", "0 0 24 24");
    });

    it("renders a distinct markup per id", () => {
      const markups = new Set<string>();
      for (const icon of CELESTIAL_ICON_IDS) {
        const { container } = render(<CelestialIcon icon={icon} />);
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
