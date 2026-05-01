import { describe, expect, it } from "vitest";
import { compactStructuredLogData } from "../log";

describe("main logger compact formatting", () => {
  it("omits undefined object fields from compact log output", () => {
    expect(
      compactStructuredLogData([
        "message",
        {
          backend: "codex",
          itemId: undefined,
          method: "thread/list",
          turnId: undefined,
        },
      ]),
    ).toEqual(["message backend=codex method=thread/list"]);
  });

  it("drops empty structured payloads after undefined fields are omitted", () => {
    expect(compactStructuredLogData(["message", { turnId: undefined }])).toEqual([
      "message",
    ]);
  });

  it("keeps non-object arguments as passthrough data", () => {
    const error = new Error("boom");

    expect(compactStructuredLogData(["message", { ok: true }, error])).toEqual([
      "message ok=true",
      error,
    ]);
  });
});
