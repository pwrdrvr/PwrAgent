import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWriteFileTool } from "../tools/write-file-tool.js";
import { createTemporaryTestDirectory } from "../testing/test-harness.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("write_file tool", () => {
  it("creates a new file and returns a concise success result", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);
    const tool = createWriteFileTool();

    const result = await tool.execute(
      tool.parseArguments({ path: "src/new-file.ts", content: "export const value = 1;\n" }),
      { cwd: workspace.path, approvalPolicy: "never" },
    );

    expect(await fs.readFile(path.join(workspace.path, "src", "new-file.ts"), "utf8")).toBe(
      "export const value = 1;\n",
    );
    expect(result).toEqual({
      success: true,
      output: "Created src/new-file.ts.",
      data: {
        path: "src/new-file.ts",
        created: true,
        bytes: Buffer.byteLength("export const value = 1;\n", "utf8"),
      },
    });
  });

  it("requests approval before mutating when policy is guarded", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);
    const tool = createWriteFileTool();
    const requestApproval = vi.fn(async () => ({ decision: "decline" }));

    const result = await tool.execute(
      tool.parseArguments({ path: "src/new-file.ts", content: "" }),
      {
        cwd: workspace.path,
        approvalPolicy: "on-request",
        requestApproval,
      },
    );

    await expect(fs.stat(path.join(workspace.path, "src", "new-file.ts"))).rejects.toThrow();
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "fileChange",
        path: "src/new-file.ts",
      }),
    );
    expect(result).toEqual({
      success: false,
      output: "Approval declined for write_file: src/new-file.ts",
    });
  });
});
