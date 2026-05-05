import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  BranchIcon,
  DiscordIcon,
  FolderIcon,
  NewThreadIcon,
  SettingsIcon,
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
