import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsPathRow } from "../SettingsPathRow";

afterEach(cleanup);

describe("SettingsPathRow", () => {
  it.each([
    ["C:/Users/operator/.codex", "C:\\Users\\operator\\.codex"],
    ["//server/share/.codex", "\\\\server\\share\\.codex"],
    ["/home/operator/.codex", "/home/operator/.codex"],
  ])("displays the filesystem path %s natively", (input, expected) => {
    render(<SettingsPathRow title="System default" path={input} selected />);
    expect(screen.getByText(expected)).toHaveAttribute("title", expected);
  });

  it("preserves failure prose and application titles", () => {
    render(
      <SettingsPathRow
        title="Editor / Terminal"
        path="C:/tools/codex failed: see https://example.test/help"
        pathIsDetail
        selected={false}
      />,
    );
    expect(screen.getByText("Editor / Terminal")).toBeInTheDocument();
    expect(screen.getByText("C:/tools/codex failed: see https://example.test/help")).toBeInTheDocument();
  });
});
