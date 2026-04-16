import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../App";

describe("App", () => {
  it("renders the shell navigation and desktop bridge status", () => {
    Object.defineProperty(window, "pwragnt", {
      configurable: true,
      value: {
        ping: () => "pong",
        platform: "darwin",
        versions: {
          electron: "41.2.1"
        }
      }
    });

    render(<App />);

    expect(
      screen.getByRole("heading", { level: 1, name: "PwrAgnt" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "Inbox" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Recents" })
    ).toBeInTheDocument();
    expect(screen.getByText("Ping: pong")).toBeInTheDocument();
    expect(screen.getByText("Platform: darwin")).toBeInTheDocument();
  });
});
