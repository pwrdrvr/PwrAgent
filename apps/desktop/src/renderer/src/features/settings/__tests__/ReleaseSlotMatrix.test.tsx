import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppUpdateReleaseVersions } from "../../../../../shared/app-metadata";
import { ReleaseSlotMatrix } from "../ReleaseSlotMatrix";

const RELEASES: AppUpdateReleaseVersions = {
  fetchedAt: 1,
  stable: {
    latest: { version: "v1.0.3" },
    prerelease: { version: "v1.0.3" },
  },
  beta: {
    // The shape the two-control UI could not report: an empty Beta Latest
    // sitting beside a populated Beta Prerelease.
    latest: { unavailableReason: "No beta release found." },
    prerelease: { version: "v1.1.0-alpha.2" },
  },
};

function renderMatrix(
  overrides: Partial<Parameters<typeof ReleaseSlotMatrix>[0]> = {},
) {
  const onSelect = vi.fn(async () => undefined);
  render(
    <ReleaseSlotMatrix
      channel="prerelease"
      installedVersion="1.1.0-alpha.2"
      releaseVersions={RELEASES}
      releasesSettled
      train="beta"
      onSelect={onSelect}
      {...overrides}
    />,
  );
  return { onSelect };
}

afterEach(() => {
  cleanup();
});

describe("ReleaseSlotMatrix", () => {
  it("states every slot's own version, not the one the selection sits on", () => {
    // The bug this replaced: each segmented control labelled itself with the
    // slot the OTHER control was currently on, so with the track control on
    // Latest the Beta button read "Beta — Unavailable" while Beta Prerelease
    // held a shipped alpha one click away.
    renderMatrix({ channel: "latest", train: "stable" });

    expect(
      screen.getByRole("radio", { name: "Stable Latest — v1.0.3" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Stable Prerelease — v1.0.3" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Beta Prerelease — v1.1.0-alpha.2" }),
    ).toBeInTheDocument();
  });

  it("says why an empty slot is empty, and keeps it selectable", () => {
    const { onSelect } = renderMatrix();

    const betaLatest = screen.getByRole("radio", {
      name: "Beta Latest — Unavailable",
    });
    // The reason comes from the release read, so a feed that broke and a
    // train that simply has nothing yet do not read the same.
    expect(betaLatest).toHaveTextContent("No beta release found.");
    expect(betaLatest).not.toBeDisabled();

    fireEvent.click(betaLatest);
    expect(onSelect).toHaveBeenCalledWith({
      train: "beta",
      channel: "latest",
    });
  });

  it("falls back to a generic reason when the read reported none", () => {
    renderMatrix({
      releaseVersions: {
        ...RELEASES,
        beta: { latest: {}, prerelease: { version: "v1.1.0-alpha.2" } },
      },
    });

    expect(
      screen.getByRole("radio", { name: "Beta Latest — Unavailable" }),
    ).toHaveTextContent("Nothing published here yet.");
  });

  it("separates a read still in flight from a slot that answered empty", () => {
    renderMatrix({ releaseVersions: undefined, releasesSettled: false });

    expect(
      screen.getAllByRole("radio", { name: /— Loading…$/ }),
    ).toHaveLength(4);
    expect(
      screen.queryByRole("radio", { name: /Unavailable/ }),
    ).not.toBeInTheDocument();
  });

  it("marks the running build's slot and the selected slot separately", () => {
    // They are usually the same tile and must still be distinguishable: an
    // operator who pinned Stable while running an alpha needs to see both.
    renderMatrix({ channel: "latest", train: "stable" });

    const installed = screen.getByRole("radio", {
      name: "Beta Prerelease — v1.1.0-alpha.2",
    });
    expect(installed).toHaveTextContent("Installed");
    expect(installed).toHaveAttribute("aria-checked", "false");

    const selected = screen.getByRole("radio", {
      name: "Stable Latest — v1.0.3",
    });
    expect(selected).toHaveAttribute("aria-checked", "true");
    expect(selected).not.toHaveTextContent("Installed");
  });

  it("writes both axes in one patch so main can derive the pin", () => {
    const { onSelect } = renderMatrix({ channel: "latest", train: "stable" });

    fireEvent.click(
      screen.getByRole("radio", { name: "Beta Prerelease — v1.1.0-alpha.2" }),
    );
    expect(onSelect).toHaveBeenCalledWith({
      train: "beta",
      channel: "prerelease",
    });
  });

  it("does not write when the operator re-picks the current slot", () => {
    const { onSelect } = renderMatrix();

    fireEvent.click(
      screen.getByRole("radio", { name: "Beta Prerelease — v1.1.0-alpha.2" }),
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps exactly the selected tile in the tab order", () => {
    renderMatrix();

    const tabbable = screen
      .getAllByRole("radio")
      .filter((tile) => tile.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toHaveAccessibleName(
      "Beta Prerelease — v1.1.0-alpha.2",
    );
  });

  it("moves focus with the arrows without changing the selection", () => {
    // Picking a slot rewrites which build the app installs, so selection
    // must not follow focus — the operator commits with Space, Enter, or a
    // click.
    const { onSelect } = renderMatrix({ channel: "latest", train: "stable" });

    const stableLatest = screen.getByRole("radio", {
      name: "Stable Latest — v1.0.3",
    });
    stableLatest.focus();
    fireEvent.keyDown(stableLatest, { key: "ArrowDown" });
    expect(document.activeElement).toHaveAccessibleName(
      "Beta Latest — Unavailable",
    );

    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: "ArrowRight",
    });
    expect(document.activeElement).toHaveAccessibleName(
      "Beta Prerelease — v1.1.0-alpha.2",
    );
    expect(onSelect).not.toHaveBeenCalled();
    expect(stableLatest).toHaveAttribute("aria-checked", "true");
  });
});
