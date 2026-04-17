import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { Composer } from "../Composer";

describe("Composer", () => {
  it("inserts skill markdown from autocomplete and sends it through startTurn", async () => {
    const startTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      runId: "turn-1",
    }));
    const refresh = vi.fn(async () => undefined);

    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn,
        }}
        disabled={false}
        onRefresh={refresh}
        skills={[
          {
            name: "frontend-design",
            description: "Design and verify renderer UI work.",
            path: "/Users/huntharo/.codex/skills/frontend-design/SKILL.md",
            enabled: true,
          },
        ]}
        thread={{
          id: "thread-1",
          title: "Build Codex client",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "Use $fr" } });

    expect(screen.getByRole("listbox", { name: "Skills" })).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(screen.getByText("$frontend-design")).toBeInTheDocument();
    expect(screen.getByLabelText("Reply")).toHaveValue("Use $frontend-design ");
    expect(
      screen.queryByRole("listbox", { name: "Skills" })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        input: [
          {
            type: "text",
            text: "Use [$frontend-design](/Users/huntharo/.codex/skills/frontend-design/SKILL.md)",
          },
        ],
      });
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("applies the focused skill option when activated from the keyboard", async () => {
    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-1",
            runId: "turn-1",
          }),
        }}
        disabled={false}
        onRefresh={async () => undefined}
        skills={[
          {
            name: "ce:plan",
            description: "Turn feature descriptions into implementation plans.",
            path: "/Users/huntharo/.codex/skills/ce-plan/SKILL.md",
            enabled: true,
          },
        ]}
        thread={{
          id: "thread-1",
          title: "Build Codex client",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "$ce:pl" } });

    const option = screen.getByRole("button", { name: /\$ce:plan/i });
    option.focus();
    fireEvent.click(option);

    expect(screen.getByLabelText("Reply")).toHaveValue("$ce:plan ");
    expect(
      screen.queryByRole("listbox", { name: "Skills" })
    ).not.toBeInTheDocument();
  });
});
