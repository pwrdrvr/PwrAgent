import { describe, expect, it } from "vitest";
import { finalTurnOutputText } from "../turn-output";

describe("finalTurnOutputText", () => {
  it("takes the last non-empty text part of a multi-message turn", () => {
    expect(finalTurnOutputText([
      { type: "text", text: "Now re-rendering the screenshot." },
      { type: "text", text: "  The screenshot is updated.  " },
      { type: "text", text: "   " },
    ])).toBe("The screenshot is updated.");
  });

  it("returns a single part unchanged apart from trimming", () => {
    expect(finalTurnOutputText([{ type: "text", text: " Done. " }])).toBe("Done.");
  });

  it("has no text for missing, empty, or non-text output", () => {
    expect(finalTurnOutputText(undefined)).toBeUndefined();
    expect(finalTurnOutputText([])).toBeUndefined();
    expect(finalTurnOutputText([{ type: "image", url: "x" }, null, { type: "text" }]))
      .toBeUndefined();
  });
});
