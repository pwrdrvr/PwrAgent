import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../lib/desktop-api";
import { SlackOpenAppMessagesButton, SlackPairSteps } from "../SlackPairSteps";

afterEach(() => {
  cleanup();
});

describe("SlackPairSteps", () => {
  it("names the app the way Slack lists it", () => {
    render(<SlackPairSteps appName="PwrAgent - fixture-user" />);

    expect(
      screen.getAllByText("PwrAgent - fixture-user", { selector: "strong" }),
    ).toHaveLength(2);
    expect(screen.getByText("Messages", { selector: "strong" })).toBeInTheDocument();
  });

  it("says why Slack could not be opened", async () => {
    const openSlackAppMessages = vi.fn(async () => {
      throw new Error("Save the App-Level Token first.");
    });
    render(
      <SlackOpenAppMessagesButton
        desktopApi={{ openSlackAppMessages } as unknown as DesktopApi}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open in Slack" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Save the App-Level Token first.",
    );
    expect(screen.getByRole("button", { name: "Open in Slack" })).toBeEnabled();
  });
});
