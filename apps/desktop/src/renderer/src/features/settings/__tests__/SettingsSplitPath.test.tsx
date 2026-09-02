import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsSplitPath } from "../SettingsSplitPath";

afterEach(() => {
  cleanup();
});

/**
 * The split is what makes middle truncation possible in pure CSS: the head
 * ellipsizes, the tail is pinned. Getting the boundary wrong is invisible
 * until a path is long enough to clip, which is exactly when it matters.
 */
describe("SettingsSplitPath", () => {
  const parts = (path: string) => {
    const { container } = render(<SettingsSplitPath value={path} />);
    return {
      head: container.querySelector(".settings-splitpath__head")?.textContent,
      tail: container.querySelector(".settings-splitpath__tail")?.textContent,
      text: container.querySelector(".settings-splitpath")?.textContent,
    };
  };

  it("pins the last POSIX segment", () => {
    expect(parts("/Users/operator/.pwragent/profiles/work")).toEqual({
      head: "/Users/operator/.pwragent/profiles",
      tail: "/work",
      text: "/Users/operator/.pwragent/profiles/work",
    });
  });

  it("pins the last Windows segment", () => {
    expect(parts("C:\\Users\\operator\\.pwragent\\profiles\\work")).toEqual({
      head: "C:\\Users\\operator\\.pwragent\\profiles",
      tail: "\\work",
      text: "C:\\Users\\operator\\.pwragent\\profiles\\work",
    });
  });

  it("keeps a root-level path whole", () => {
    // Splitting at index 0 would leave an empty head and pin the entire
    // string, which sizes the box to the full value and defeats the point.
    expect(parts("/work")).toEqual({
      head: "/work",
      tail: undefined,
      text: "/work",
    });
  });

  it("keeps a value with no separator whole", () => {
    expect(parts("~")).toEqual({ head: "~", tail: undefined, text: "~" });
  });

  it("carries the untruncated value on title, defaulting to the display value", () => {
    render(
      <SettingsSplitPath
        title="/var/folders/07/abc/.pwragent/profiles/default"
        value="~/.pwragent/profiles/default"
      />,
    );
    expect(
      screen.getByTitle("/var/folders/07/abc/.pwragent/profiles/default"),
    ).toBeInTheDocument();

    render(<SettingsSplitPath value="~/.codex" />);
    expect(screen.getByTitle("~/.codex")).toBeInTheDocument();
  });
});
