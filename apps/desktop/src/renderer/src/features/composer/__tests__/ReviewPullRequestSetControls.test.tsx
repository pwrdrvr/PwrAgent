import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewPullRequestModeChoice } from "../ReviewPullRequestSetControls";

afterEach(() => {
  cleanup();
});

describe("ReviewPullRequestModeChoice", () => {
  it("shows Separately chosen when Together was chosen but is unavailable, as submission reviews them", () => {
    render(
      <ReviewPullRequestModeChoice
        count={9}
        together
        togetherDescription="One reviewer reads every diff together"
        togetherUnavailableReason="A combined review takes at most 8 pull requests."
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("radio", { name: /Separately/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Together/ })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /Together/ })).toBeDisabled();
  });

  it("shows the operator's choice while Together is available", () => {
    render(
      <ReviewPullRequestModeChoice
        count={2}
        together
        togetherDescription="One reviewer reads every diff together"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("radio", { name: /Together/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Separately/ })).not.toBeChecked();
  });
});
