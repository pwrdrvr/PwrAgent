import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReadFileTool } from "../tools/read-file-tool.js";
import { createTemporaryTestDirectory } from "../testing/test-harness.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("read_file tool", () => {
  it("returns numbered lines for a requested range", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);
    await fs.mkdir(path.join(workspace.path, "src"), { recursive: true });
    await fs.writeFile(
      path.join(workspace.path, "src", "demo.ts"),
      ["alpha", "beta", "gamma", "delta"].join("\n"),
      "utf8",
    );
    const tool = createReadFileTool();

    const result = await tool.execute(
      tool.parseArguments({ path: "src/demo.ts", startLine: 2, endLine: 3 }),
      { cwd: workspace.path },
    );

    expect(result).toEqual({
      success: true,
      output: "src/demo.ts\n2: beta\n3: gamma",
      data: {
        path: "src/demo.ts",
        startLine: 2,
        endLine: 3,
        totalLines: 4,
        truncated: true,
      },
      commandAction: "read",
    });
  });

  it("returns actionable output for missing files", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);
    const tool = createReadFileTool();

    await expect(
      tool.execute(tool.parseArguments({ path: "src/missing.ts" }), {
        cwd: workspace.path,
      }),
    ).rejects.toThrow(
      /read_file failed: unable to read src\/missing\.ts:/,
    );
  });
});
