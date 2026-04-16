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
});
