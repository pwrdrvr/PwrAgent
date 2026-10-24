import { describe, expect, it } from "vitest";
import { readUuidV7Timestamp } from "../uuid-v7";

describe("readUuidV7Timestamp", () => {
  it("reads the millisecond time from a UUIDv7", () => {
    expect(readUuidV7Timestamp("019a3c1f-5e2b-7a82-b681-9ca30ad325fa")).toBe(0x019a3c1f5e2b);
  });

  it("returns undefined for a UUIDv4, whose leading bits are random", () => {
    // A Claude turn id. Read as milliseconds, it is Jan 7, 6903.
    expect(readUuidV7Timestamp("8d94fa8e-3a98-464b-914e-9b77c8bedc71")).toBeUndefined();
  });

  it.each([
    undefined,
    "",
    "turn-1",
    "019a3c1f5e2b7a82b6819ca30ad325fa",
    "019a3c1f-5e2b-7a82-c681-9ca30ad325fa",
  ])("returns undefined for %j", (id) => {
    expect(readUuidV7Timestamp(id)).toBeUndefined();
  });
});
