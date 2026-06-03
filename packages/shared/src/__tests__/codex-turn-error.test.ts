import { describe, expect, it } from "vitest";
import { parseCodexTurnErrorMessage } from "../codex-turn-error";

describe("parseCodexTurnErrorMessage", () => {
  it("extracts the human message from a nested provider error envelope", () => {
    const raw =
      '{ "type": "error", "error": { "type": "image_generation_user_error", "code": "invalid_value", "message": "The model \'gpt-image-2\' does not exist.", "param": "tools" }, "status": 400 }';
    expect(parseCodexTurnErrorMessage(raw)).toBe(
      "The model 'gpt-image-2' does not exist.",
    );
  });

  it("returns a plain message unchanged", () => {
    expect(parseCodexTurnErrorMessage("Something went wrong")).toBe(
      "Something went wrong",
    );
  });

  it("reads a top-level message field", () => {
    expect(parseCodexTurnErrorMessage('{"message":"boom"}')).toBe("boom");
  });

  it("reads an error string when there is no message field", () => {
    expect(parseCodexTurnErrorMessage('{"error":"bad request"}')).toBe(
      "bad request",
    );
  });

  it("falls back to the raw text when JSON has no recognizable message", () => {
    expect(parseCodexTurnErrorMessage('{"status":500}')).toBe('{"status":500}');
  });

  it("falls back for empty or missing input", () => {
    expect(parseCodexTurnErrorMessage("")).toBe("Turn failed.");
    expect(parseCodexTurnErrorMessage(null)).toBe("Turn failed.");
    expect(parseCodexTurnErrorMessage(undefined)).toBe("Turn failed.");
  });

  it("does not choke on malformed JSON", () => {
    expect(parseCodexTurnErrorMessage('{"error": ')).toBe('{"error":');
  });
});
