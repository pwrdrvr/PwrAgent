import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createListFilesTool } from "../tools/list-files-tool.js";
import { createTemporaryTestDirectory } from "../testing/test-harness.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("list_files tool", () => {
  it("returns repository-relative paths for a nested workspace scope", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);
    await fs.mkdir(path.join(workspace.path, "src", "nested"), { recursive: true });
    await fs.writeFile(path.join(workspace.path, "src", "app.ts"), "export {};\n", "utf8");
    await fs.writeFile(path.join(workspace.path, "src", "nested", "util.ts"), "export {};\n", "utf8");
    const tool = createListFilesTool();

    const result = await tool.execute(
      tool.parseArguments({ path: "src", limit: 10 }),
      { cwd: workspace.path },
    );

    expect(result).toEqual({
      success: true,
      output: "src/app.ts\nsrc/nested/util.ts",
      data: {
        path: "src",
        files: ["src/app.ts", "src/nested/util.ts"],
        truncated: false,
      },
      commandAction: "listFiles",
    });
  });
});
