import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { JsonFilePreview } from "../JsonFilePreview";

describe("JSON file preview", () => {
  it("formats nested JSON while preserving and highlighting literals", () => {
    const content = '{"id":9007199254740993,"id":1e+30,"text":"brace } comma , quote \\" and \\u0061","items":[{},[],true,null]}';
    const { container } = render(<JsonFilePreview content={content} />);
    expect(screen.getByLabelText("JSON contents").textContent).toBe(
      '{\n  "id": 9007199254740993,\n  "id": 1e+30,\n  "text": "brace } comma , quote \\" and \\u0061",\n  "items": [\n    {},\n    [],\n    true,\n    null\n  ]\n}',
    );
    expect(container.querySelector(".json-file-preview__key")).toHaveTextContent('"id"');
    expect(container.querySelector(".json-file-preview__number")).toHaveTextContent("9007199254740993");
    expect(container.querySelector(".json-file-preview__string")).toHaveTextContent("brace } comma");
    expect(container.querySelector(".json-file-preview__literal")).toHaveTextContent("true");
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

  it("bounds syntax elements for large arrays while retaining formatted text", () => {
    const content = `[${"1,".repeat(5000)}1]`;
    const { container } = render(<JsonFilePreview content={content} />);
    expect(container.querySelectorAll(".json-file-preview__code span")).toHaveLength(0);
    expect(screen.getByLabelText("JSON contents").textContent).toBe(`[\n${"  1,\n".repeat(5000)}  1\n]`);
  });

  it("escapes HTML within highlighted JSON strings", () => {
    const { container } = render(<JsonFilePreview content={'{"text":"<script>alert(1)</script>"}'} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector(".json-file-preview__string")).toHaveTextContent("<script>alert(1)</script>");
  });
});
