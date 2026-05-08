import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  BranchIcon,
  DiscordIcon,
  FolderIcon,
  MattermostIcon,
  NewThreadIcon,
  SettingsIcon,
  SmileyIcon,
  TelegramIcon,
  UnlinkedDotIcon,
  WorkspaceIcon,
  WorktreeIcon,
} from "../index";

afterEach(() => {
  cleanup();
});

const ALL_ICONS = [
  ["FolderIcon", FolderIcon],
  ["BranchIcon", BranchIcon],
  ["WorkspaceIcon", WorkspaceIcon],
  ["WorktreeIcon", WorktreeIcon],
  ["UnlinkedDotIcon", UnlinkedDotIcon],
  ["SettingsIcon", SettingsIcon],
  ["SmileyIcon", SmileyIcon],
  ["NewThreadIcon", NewThreadIcon],
] as const;

describe("icon library", () => {
  it.each(ALL_ICONS)(
    "%s renders an SVG with shared defaults (currentColor, 16px, stroke 1.75)",
    (_name, Icon) => {
      const { container } = render(<Icon />);
      const svg = container.querySelector("svg");
      expect(svg).toBeInTheDocument();
      expect(svg).toHaveAttribute("width", "16");
      expect(svg).toHaveAttribute("height", "16");
      expect(svg).toHaveAttribute("viewBox", "0 0 24 24");
      expect(svg).toHaveAttribute("stroke", "currentColor");
      expect(svg).toHaveAttribute("stroke-width", "1.75");
      // Decorative by default — no aria-label means hidden from AT.
      expect(svg).toHaveAttribute("aria-hidden", "true");
    },
  );

  it("respects size and strokeWidth overrides", () => {
    const { container } = render(<FolderIcon size={24} strokeWidth={2.25} />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("width", "24");
    expect(svg).toHaveAttribute("height", "24");
    expect(svg).toHaveAttribute("stroke-width", "2.25");
  });

  it("switches to role=img when an aria-label is supplied", () => {
    const { container } = render(<FolderIcon aria-label="Local directory" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("role", "img");
    expect(svg).toHaveAttribute("aria-label", "Local directory");
    expect(svg).toHaveAttribute("aria-hidden", "false");
  });

  it.each([
    ["TelegramIcon", TelegramIcon],
    ["DiscordIcon", DiscordIcon],
  ] as const)(
    "%s renders as a filled glyph using currentColor",
    (_name, Icon) => {
      const { container } = render(<Icon />);
      const svg = container.querySelector("svg");
      expect(svg).toBeInTheDocument();
      expect(svg).toHaveAttribute("width", "16");
      expect(svg).toHaveAttribute("height", "16");
      expect(svg).toHaveAttribute("viewBox", "0 0 24 24");
      expect(svg).toHaveAttribute("fill", "currentColor");
      expect(svg).toHaveAttribute("stroke", "none");
      expect(svg).toHaveAttribute("aria-hidden", "true");
    },
  );

  describe("MattermostIcon", () => {
    // Mattermost is the one icon that does NOT render as a
    // currentColor SVG — the brand guidelines forbid altering the
    // mark, so we ship the official asset files verbatim and render
    // them via <img>. The variant prop selects which of the three
    // published colorways (white/black/denim) the surface needs.
    it("renders an <img> at the requested size", () => {
      const { container } = render(<MattermostIcon />);
      const img = container.querySelector("img");
      expect(img).toBeInTheDocument();
      expect(img).toHaveAttribute("width", "16");
      expect(img).toHaveAttribute("height", "16");
      // Vite inlines small SVG assets as data: URLs in tests; just
      // verify a src is set and that it actually carries SVG payload.
      const src = img?.getAttribute("src") ?? "";
      expect(src.length).toBeGreaterThan(0);
      expect(src).toMatch(/svg|image/i);
    });

    it("renders distinct sources for each variant", () => {
      const sources = new Set<string>();
      for (const variant of ["black", "denim", "white"] as const) {
        const { container } = render(<MattermostIcon variant={variant} />);
        const src = container.querySelector("img")?.getAttribute("src") ?? "";
        expect(src.length).toBeGreaterThan(0);
        sources.add(src);
        cleanup();
      }
      // Three variants → three distinct asset URLs.
      expect(sources.size).toBe(3);
    });

    it("respects size overrides", () => {
      const { container } = render(<MattermostIcon size={28} />);
      const img = container.querySelector("img");
      expect(img).toHaveAttribute("width", "28");
      expect(img).toHaveAttribute("height", "28");
    });
  });

  it("flows currentColor through to children via parent CSS", () => {
    const { container } = render(
      <div style={{ color: "rgb(255, 138, 31)" }}>
        <FolderIcon />
      </div>,
    );
    const svg = container.querySelector("svg");
    // The SVG itself uses stroke="currentColor"; the rendered color will be
    // the parent's color in the browser. We assert the contract here, not
    // computed style (jsdom doesn't compute SVG strokes).
    expect(svg).toHaveAttribute("stroke", "currentColor");
  });
});
