import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseNotesUrl } from "@pwragent/shared";
import { openReleaseNotes, ReleaseNotesLink } from "../ReleaseNotesLink";

const open = vi.fn();

beforeEach(() => {
  vi.stubGlobal("open", open);
});

afterEach(() => {
  cleanup();
  open.mockReset();
  vi.unstubAllGlobals();
});

describe("ReleaseNotesLink", () => {
  it("hands the exact URL to the OS browser", () => {
    const url = releaseNotesUrl("1.1.0-beta.1") as string;
    render(<ReleaseNotesLink className="x" url={url} />);

    fireEvent.click(screen.getByRole("button", { name: "Release notes" }));

    // `window.open` with `_blank` is what the window's
    // `setWindowOpenHandler` intercepts and hands to `shell.openExternal`;
    // `noopener,noreferrer` is what every other external open in this app
    // passes. See `window-external-open-release-notes.test.ts` for the main
    // half.
    expect(open).toHaveBeenCalledWith(url, "_blank", "noopener,noreferrer");
    expect(url).toBe(
      "https://github.com/pwrdrvr/PwrAgent/releases/tag/v1.1.0-beta.1",
    );
  });

  it("renders nothing at all without a URL", () => {
    // Not a disabled control, not an empty span — nothing. A compact row
    // that sized itself around a dead link would spend width on it.
    const { container } = render(
      <ReleaseNotesLink className="x" url={undefined} />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is a button, never an anchor", () => {
    // Deliberate: it performs an action rather than navigating this
    // document, and with no `href` there is no navigation for a
    // middle-click to attempt in the first place.
    const { container } = render(
      <ReleaseNotesLink className="x" url={releaseNotesUrl("1.0.6")} />,
    );

    expect(container.querySelector("a")).toBeNull();
    const button = screen.getByRole("button", { name: "Release notes" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveAttribute(
      "title",
      "https://github.com/pwrdrvr/PwrAgent/releases/tag/v1.0.6",
    );
  });

  it("takes an accessible name when the visible label cannot say which version", () => {
    // The slot matrix renders four of these at once. "Release notes,
    // Release notes, Release notes, Release notes" is not a usable list.
    render(
      <ReleaseNotesLink
        ariaLabel="Release notes for Beta Prerelease v1.1.0-alpha.5"
        className="x"
        url={releaseNotesUrl("v1.1.0-alpha.5")}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Release notes for Beta Prerelease v1.1.0-alpha.5",
      }),
    ).toBeInTheDocument();
  });

  it("takes a shorter visible label where a surface has less room", () => {
    render(<ReleaseNotesLink className="x" label="Notes" url="https://x/y" />);

    expect(screen.getByRole("button", { name: "Notes" })).toBeInTheDocument();
  });

  it("shares one open path with the surfaces that render their own button", () => {
    // The settled-check notice rides on `AppNoticeToastNotice.actions`,
    // which owns its markup. Exporting the open call is what keeps that
    // path from becoming a second opinion.
    openReleaseNotes("https://github.com/pwrdrvr/PwrAgent/releases");

    expect(open).toHaveBeenCalledWith(
      "https://github.com/pwrdrvr/PwrAgent/releases",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
