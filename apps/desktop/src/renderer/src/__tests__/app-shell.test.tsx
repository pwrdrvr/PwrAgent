import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../App";

describe("App", () => {
  it("renders the live recent-thread shell", async () => {
    Object.defineProperty(window, "pwragnt", {
      configurable: true,
      value: {
        ping: () => "pong",
        listThreads: async () => ({
          backend: "codex",
          fetchedAt: Date.now(),
          threads: [
            {
              id: "thread-1",
              title: "Build Codex client",
              summary: "Wire the app-server transport and list threads",
              source: "codex",
              linkedDirectories: [
                {
                  id: "/Users/huntharo/pwrdrvr/PwrAgnt",
                  label: "PwrAgnt",
                  path: "/Users/huntharo/pwrdrvr/PwrAgnt"
                }
              ],
              updatedAt: Date.now()
            }
          ]
        }),
        platform: "darwin",
        versions: {
          electron: "41.2.1"
        }
      }
    });

    render(<App />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Threads" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "Inbox" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "recents" })
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", {
        level: 2,
        name: "Build Codex client"
      })
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("Wire the app-server transport and list threads")
    ).toHaveLength(2);
    expect(screen.getByText("darwin")).toBeInTheDocument();
  });
});
