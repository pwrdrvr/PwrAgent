import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AppNoticeStack } from "../AppNoticeStack";
import type { AppNoticeToastNotice } from "../AppNoticeToast";

afterEach(cleanup);

describe("AppNoticeStack", () => {
  it("navigates durable notices in order and dismisses each one independently", async () => {
    const initial: AppNoticeToastNotice[] = [
      { id: "first", title: "First", message: "One", autoDismiss: false },
      { id: "second", title: "Second", message: "Two", autoDismiss: false },
      { id: "third", title: "Third", message: "Three", autoDismiss: false },
    ];

    function Harness() {
      const [notices, setNotices] = useState(initial);
      return (
        <AppNoticeStack
          durableNotices={notices}
          onDismissDurable={(id) => {
            setNotices((current) => current.filter((notice) => notice.id !== id));
          }}
        />
      );
    }

    render(<Harness />);

    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.queryByText("Second")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous notice" }))
      .toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Next notice" }));
    expect(screen.getByText("Second")).toBeInTheDocument();
    expect(screen.getByText("2 of 3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(await screen.findByText("Third")).toBeInTheDocument();
    expect(screen.getByText("2 of 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Previous notice" }));
    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.queryByText("Second")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(await screen.findByText("Third")).toBeInTheDocument();
    expect(screen.getByText("1 of 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous notice" }))
      .toBeDisabled();
    expect(screen.getByRole("button", { name: "Next notice" }))
      .toBeDisabled();
  });
});
