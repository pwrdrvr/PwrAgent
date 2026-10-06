import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { JsonFilePreview } from "../JsonFilePreview";

describe("JSON file preview", () => {
  it("formats nested JSON while preserving literals and copies the original text", async () => {
    const content = '{"id":9007199254740993,"id":1e+30,"text":"brace } comma , quote \\" and \\u0061","items":[{},[],true,null]}';
    const copyText = vi.fn(async () => undefined);
    render(<JsonFilePreview content={content} desktopApi={{ copyText }} />);
    expect(screen.getByLabelText("JSON contents").textContent).toBe(
      '{\n  "id": 9007199254740993,\n  "id": 1e+30,\n  "text": "brace } comma , quote \\" and \\u0061",\n  "items": [\n    {},\n    [],\n    true,\n    null\n  ]\n}',
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy JSON" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(content));
  });

  it.each(["null", "false", "42", '"a string"', "[]", "{}"])("renders a JSON root value: %s", (content) => {
    render(<JsonFilePreview content={content} />);
    expect(screen.getByLabelText("JSON contents").textContent).toBe(content);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it.each(["", '{"broken":', '<script>alert("example")</script>'])("shows invalid JSON as escaped original text: %s", (content) => {
    const { container } = render(<JsonFilePreview content={content} />);
    expect(screen.getByRole("status")).toHaveTextContent("Invalid JSON");
    expect(screen.getByLabelText("JSON contents").textContent).toBe(content);
    expect(container.querySelector("script")).toBeNull();
  });

  it("bounds the expansion of a large nested document", () => {
    const content = "[".repeat(50) + "[0],".repeat(40000).slice(0, -1) + "]".repeat(50);
    render(<JsonFilePreview content={content} />);
    expect(screen.getByLabelText("JSON contents").textContent).toBe(content);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
