import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpClientRequestHandler } from "../acp/acp-client-request-handler";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-acp-requests-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("AcpClientRequestHandler", () => {
  it("requires approval for writes in default access", async () => {
    const handler = new AcpClientRequestHandler({
      executionMode: "default",
      workspaceRoots: [tempDir],
    });

    await expect(
      handler.writeTextFile({
        path: path.join(tempDir, "file.txt"),
        content: "hello",
      }),
    ).resolves.toEqual({
      outcome: "permission-required",
      reason: "write-requires-approval",
    });
  });

  it("writes inside workspace in full access", async () => {
    const target = path.join(tempDir, "nested", "file.txt");
    const handler = new AcpClientRequestHandler({
      executionMode: "full-access",
      workspaceRoots: [tempDir],
    });

    await expect(
      handler.writeTextFile({ path: target, content: "hello" }),
    ).resolves.toEqual({ outcome: "allowed" });
    expect(readFileSync(target, "utf8")).toBe("hello");
  });

  it("denies filesystem and terminal requests outside workspace roots", async () => {
    const handler = new AcpClientRequestHandler({
      executionMode: "full-access",
      workspaceRoots: [tempDir],
    });

    await expect(
      handler.writeTextFile({ path: "/outside.txt", content: "hello" }),
    ).resolves.toEqual({
      outcome: "denied",
      reason: "path-outside-workspace",
    });
    await expect(
      handler.createTerminal({ cwd: "/outside", command: "npm test" }),
    ).resolves.toEqual({
      outcome: "denied",
      reason: "cwd-outside-workspace",
    });
  });
});
