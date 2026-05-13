import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { readAppLogSnapshot, readFileTail } from "../app-logs";

describe("app log snapshots", () => {
  it("reads the whole file when it fits under the tail cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pwragent-logs-"));
    const filePath = join(dir, "main.log");
    await writeFile(filePath, "one\ntwo\nthree\n", "utf8");

    await expect(readFileTail(filePath, 1024)).resolves.toMatchObject({
      content: "one\ntwo\nthree\n",
      sizeBytes: 14,
      truncated: false,
    });
  });

  it("keeps the last complete lines when the log is larger than the cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pwragent-logs-"));
    const filePath = join(dir, "main.log");
    await writeFile(filePath, "first line\nsecond line\nthird line\n", "utf8");

    await expect(readFileTail(filePath, 18)).resolves.toMatchObject({
      content: "third line\n",
      truncated: true,
    });
  });

  it("returns an unavailable snapshot when the log path cannot be read", async () => {
    const snapshot = await readAppLogSnapshot({
      filePath: "/no/such/pwragent.log",
    });

    expect(snapshot).toMatchObject({
      kind: "log-snapshot",
      path: "/no/such/pwragent.log",
      content: "",
      truncated: false,
    });
    expect(snapshot.unavailableReason).toBeTruthy();
  });
});
