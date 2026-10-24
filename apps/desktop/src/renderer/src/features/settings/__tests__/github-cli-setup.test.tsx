import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GitHubCliSetup, isGhVersionTooOldForAttachments } from "../github-cli-setup";

afterEach(cleanup);

describe("GitHub CLI attachment compatibility", () => {
  it.each([
    ["2.46.0", true],
    ["2.98.99", true],
    ["2.99.0-rc.1", true],
    ["2.99.0", false],
    ["2.99", false],
    ["2.100.0", false],
    ["3.0.0", false],
    [undefined, false],
    ["unknown", false],
  ])("checks %s against 2.99.0", (version, expected) => {
    expect(isGhVersionTooOldForAttachments(version)).toBe(expected);
  });
});

describe("GitHub CLI setup instructions", () => {
  it.each([
    ["darwin", "brew upgrade gh"],
    ["win32", "winget upgrade --id GitHub.cli --exact --source winget"],
  ] as const)("shows upgrade instructions for %s", (platform, command) => {
    render(<GitHubCliSetup desktopApi={{ platform }} upgrade version="2.46.0" />);
    expect(screen.getByText(command)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Upgrade to 2.99.0 or newer.");
  });

  it("offers the official APT repository and other Linux installation methods", () => {
    render(<GitHubCliSetup desktopApi={{ platform: "linux" }} upgrade version="2.46.0" />);
    expect(screen.getByText(/sudo apt install gh/)).toHaveTextContent("https://cli.github.com/packages stable main");
    expect(screen.getByRole("link", { name: "Open install guide" })).toHaveAttribute(
      "href", "https://github.com/cli/cli/blob/trunk/docs/install_linux.md",
    );
    expect(screen.getByText(/For other Linux distributions/)).toBeInTheDocument();
  });

  it("offers installation when gh is missing", () => {
    render(<GitHubCliSetup desktopApi={{ platform: "darwin" }} />);
    expect(screen.getByText("brew install gh")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
