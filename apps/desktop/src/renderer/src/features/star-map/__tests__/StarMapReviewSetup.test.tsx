import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendCapabilities, BackendSummary, NavigationThreadSummary } from "@pwragent/shared";
import { StarMapReviewSetup } from "../StarMapReviewSetup";

const thread = {
  id: "t-local", title: "Local work", titleSource: "generated", linkedDirectories: [],
  source: "codex", inbox: { inInbox: false }, updatedAt: 1,
} as unknown as NavigationThreadSummary;

function backend(reviewAutoFix: boolean): BackendSummary {
  const capabilities = {
    approvalRequests: true, createThread: true, interruptTurn: true, listThreads: true,
    multiDirectoryThreads: true, readThread: true, renameThread: true, resumeThread: true,
    startReview: true, startTurn: true, steerTurn: false, toolUse: true, transcriptPagination: false,
    reviewRunMode: true, reviewRunner: true, reviewCodexSubAgent: true,
    ...(reviewAutoFix ? { reviewAutoFix: true } : {}),
  } as BackendCapabilities;
  return { kind: "codex", label: "Codex", capabilities, executionModes: [] } as unknown as BackendSummary;
}

function renderSetup(reviewAutoFix: boolean, reviewAutoFixDefault?: boolean) {
  const onSubmit = vi.fn();
  render(
    <StarMapReviewSetup
      busy={false}
      backend={backend(reviewAutoFix)}
      directories={[]}
      onCancel={vi.fn()}
      onSubmit={onSubmit}
      reviewAutoFixDefault={reviewAutoFixDefault}
      submitting={false}
      thread={thread}
    />,
  );
  return onSubmit;
}

afterEach(cleanup);

/**
 * Rule: the review request says what follows it only to an owner that
 * advertises reviewAutoFix, and then carries the switch's state: on by
 * default, "wait" once unticked.
 */
describe("Star Map review setup Auto-fix", () => {
  it("asks for auto-fix by default, and wait once the switch is off", () => {
    const onSubmit = renderSetup(true);
    const toggle = screen.getByRole("switch", { name: "Auto-fix findings" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ afterReview: "auto-fix" }));

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ afterReview: "wait" }));
  });

  it("starts off when Settings turns Auto-fix off, and a click still auto-fixes this review", () => {
    const onSubmit = renderSetup(true, false);
    const toggle = screen.getByRole("switch", { name: "Auto-fix findings" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ afterReview: "wait" }));

    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ afterReview: "auto-fix" }));
  });

  it("follows a Settings default that arrives after the card opened, until clicked", () => {
    const onSubmit = vi.fn();
    const props = { busy: false, backend: backend(true), directories: [], onCancel: vi.fn(), onSubmit,
      submitting: false, thread };
    const { rerender } = render(<StarMapReviewSetup {...props} />);
    const toggle = screen.getByRole("switch", { name: "Auto-fix findings" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    // The window's settings snapshot loads with the setting off.
    rerender(<StarMapReviewSetup {...props} reviewAutoFixDefault={false} />);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    rerender(<StarMapReviewSetup {...props} reviewAutoFixDefault={false} />);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ afterReview: "auto-fix" }));
  });

  it("offers no switch and sends no choice to an owner without the capability", () => {
    const onSubmit = renderSetup(false);
    expect(screen.queryByRole("switch", { name: "Auto-fix findings" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).not.toHaveProperty("afterReview");
  });
});
