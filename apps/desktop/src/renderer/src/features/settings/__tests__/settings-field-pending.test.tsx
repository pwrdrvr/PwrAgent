import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SegmentedField, SettingsField, ToggleField } from "../SettingsLayout";

afterEach(() => {
  cleanup();
});

/** A write whose settle point the test controls, standing in for the
 *  config-write + adapter-reload round trip a real toggle triggers. */
function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function pendingIndicator(): HTMLElement | null {
  return document.querySelector(".settings-pending");
}

function spinner(): HTMLElement | null {
  return document.querySelector(".settings-pending .pending-spinner");
}

const MODES = [
  { label: "Every message", value: "every_message" },
  { label: "@ mention only", value: "mention_only" },
] as const;

describe("settings field pending state", () => {
  it("shows pending on the toggle that was actuated and clears it on success", async () => {
    const write = deferred();
    render(
      <ToggleField
        checked={false}
        label="Slack"
        source="config"
        onChange={() => write.promise}
      />,
    );

    const toggle = screen.getByRole("switch", { name: "Slack" });
    expect(toggle).not.toHaveAttribute("aria-busy");
    expect(spinner()).toBeNull();
    expect(pendingIndicator()).toBeNull();

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(spinner()).toBeInTheDocument();
    });
    expect(toggle).toHaveAttribute("aria-busy", "true");
    expect(pendingIndicator()).toHaveTextContent("Saving…");

    await act(async () => {
      write.resolve();
      await write.promise;
    });

    expect(spinner()).toBeNull();
    expect(toggle).not.toHaveAttribute("aria-busy");
    expect(pendingIndicator()).toBeNull();
  });

  it("clears the toggle's pending state when the write fails", async () => {
    const write = deferred();
    render(
      <ToggleField
        checked={false}
        label="Slack"
        source="config"
        onChange={() => write.promise}
      />,
    );

    fireEvent.click(screen.getByRole("switch", { name: "Slack" }));
    await waitFor(() => {
      expect(spinner()).toBeInTheDocument();
    });

    await act(async () => {
      write.reject(new Error("config write failed"));
      await write.promise.catch(() => undefined);
    });

    // The row goes back to rest even though the value never changed — a
    // spinner left spinning reads as a save that is still running.
    expect(spinner()).toBeNull();
    expect(
      screen.getByRole("switch", { name: "Slack" }),
    ).not.toHaveAttribute("aria-busy");
  });

  it("leaves a sibling field untouched while one field saves", async () => {
    const write = deferred();
    render(
      <>
        <ToggleField
          checked={false}
          label="Slack"
          source="config"
          onChange={() => write.promise}
        />
        <ToggleField
          checked={false}
          label="Discord"
          source="config"
          onChange={() => Promise.resolve()}
        />
      </>,
    );

    fireEvent.click(screen.getByRole("switch", { name: "Slack" }));

    await waitFor(() => {
      expect(document.querySelectorAll(".pending-spinner")).toHaveLength(1);
    });
    expect(screen.getByRole("switch", { name: "Slack" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("switch", { name: "Discord" })).not.toHaveAttribute(
      "aria-busy",
    );

    await act(async () => {
      write.resolve();
      await write.promise;
    });
  });

  it("marks the segmented option the operator picked as busy", async () => {
    const write = deferred();
    render(
      <SegmentedField
        label="Response mode"
        options={[...MODES]}
        source="config"
        value="every_message"
        onChange={() => write.promise}
      />,
    );

    const picked = screen.getByRole("radio", { name: "@ mention only" });
    const other = screen.getByRole("radio", { name: "Every message" });

    fireEvent.click(picked);

    await waitFor(() => {
      expect(picked).toHaveAttribute("aria-busy", "true");
    });
    expect(other).not.toHaveAttribute("aria-busy");
    expect(pendingIndicator()).toHaveTextContent("Saving…");

    await act(async () => {
      write.resolve();
      await write.promise;
    });

    expect(picked).not.toHaveAttribute("aria-busy");
    expect(spinner()).toBeNull();
  });

  it("holds pending until the last of two overlapping writes settles", async () => {
    const first = deferred();
    const second = deferred();
    const writes = [first, second];
    let call = 0;
    render(
      <ToggleField
        checked={false}
        label="Slack"
        source="config"
        onChange={() => writes[call++].promise}
      />,
    );

    const toggle = screen.getByRole("switch", { name: "Slack" });
    fireEvent.click(toggle);
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(spinner()).toBeInTheDocument();
    });

    await act(async () => {
      first.resolve();
      await first.promise;
    });
    // One write is still out; clearing here would call the save done early.
    expect(spinner()).toBeInTheDocument();

    await act(async () => {
      second.resolve();
      await second.promise;
    });
    expect(spinner()).toBeNull();
  });

  it("announces the pending state, and stands down no announcer at rest", async () => {
    const write = deferred();
    render(
      <ToggleField
        checked={false}
        label="Slack"
        source="config"
        onChange={() => write.promise}
      />,
    );

    // A pane holds dozens of these fields, so an idle one must not leave a
    // standing live region behind — settings-screen.test.tsx queries
    // `getByRole("status")` expecting the pane's own single announcer.
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: "Slack" }));

    let status: HTMLElement | undefined;
    await waitFor(() => {
      status = screen.getByRole("status");
      expect(status).toHaveTextContent("Saving…");
    });
    // The ring itself is decorative; the text is what carries the state.
    expect(status?.querySelector(".pending-spinner")).toHaveAttribute(
      "aria-hidden",
      "true",
    );

    await act(async () => {
      write.resolve();
      await write.promise;
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("gives the switch its own accessible name when the row label needs context", () => {
    render(
      <ToggleField
        checked={false}
        label="Enabled"
        switchLabel="Enable Grok"
        source="config"
        onChange={() => Promise.resolve()}
      />,
    );

    // The row reads "Enabled" beside its card heading; the switch has to
    // stand alone in a screen reader's control list.
    expect(screen.getByRole("switch", { name: "Enable Grok" })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Enabled" })).toBeNull();
  });

  it("keeps a toggle's actions out of the control row", () => {
    render(
      <ToggleField
        actions={<button type="button">Apply to launchpads</button>}
        checked={false}
        label="Enable Auto-fix PR"
        source="config"
        onChange={() => Promise.resolve()}
      />,
    );

    const row = document.querySelector(".settings-control-row");
    expect(row?.querySelector("button[type='button']:not([role='switch'])")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Apply to launchpads" }),
    ).toBeInTheDocument();
  });

  it("renders no pending affordance for a field that did not opt in", () => {
    render(
      <SettingsField
        label="Workspace URL"
        control={<input aria-label="Workspace URL" />}
      />,
    );

    expect(document.querySelector(".settings-pending")).toBeNull();
    expect(document.querySelector(".settings-control-row")).toBeNull();
  });

  it("keeps a segmented field's actions out of the control row", () => {
    render(
      <SegmentedField
        actions={<button type="button">Reset bindings</button>}
        label="Working Updates"
        options={[...MODES]}
        source="config"
        value="every_message"
        onChange={() => Promise.resolve()}
      />,
    );

    const row = document.querySelector(".settings-control-row");
    expect(row).not.toBeNull();
    // The row is the control + indicator pair; a follow-on action button
    // sitting inside it would be pushed onto the same line as the group.
    expect(
      row?.querySelector("button[type='button']:not([role='radio'])"),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Reset bindings" }),
    ).toBeInTheDocument();
  });
});
