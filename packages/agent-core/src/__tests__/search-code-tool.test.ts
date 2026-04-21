import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSearchCodeTool } from "../tools/search-code-tool.js";
import { createTemporaryTestDirectory } from "../testing/test-harness.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("search_code tool", () => {
  it("returns filename, line number, and matching text for a unique identifier", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);
    await fs.mkdir(path.join(workspace.path, "src"), { recursive: true });
    await fs.writeFile(
      path.join(workspace.path, "src", "app.ts"),
      "const UNIQUE_MARKER_42 = true;\nexport { UNIQUE_MARKER_42 };\n",
      "utf8",
    );
    const tool = createSearchCodeTool();

    const result = await tool.execute(
      tool.parseArguments({ query: "UNIQUE_MARKER_42", fixedStrings: true }),
      { cwd: workspace.path },
    );

    expect(result).toEqual({
      success: true,
      output: "src/app.ts:1: const UNIQUE_MARKER_42 = true;\nsrc/app.ts:2: export { UNIQUE_MARKER_42 };",
      data: {
        query: "UNIQUE_MARKER_42",
        path: ".",
        matches: [
          {
            path: "src/app.ts",
            line: 1,
            text: "const UNIQUE_MARKER_42 = true;",
          },
          {
            path: "src/app.ts",
            line: 2,
            text: "export { UNIQUE_MARKER_42 };",
          },
        ],
        truncated: false,
      },
      commandAction: "search",
    });
  });

  it("searches a single file when path points at a file", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);
    await fs.mkdir(path.join(workspace.path, "src"), { recursive: true });
    await fs.writeFile(
      path.join(workspace.path, "src", "app.ts"),
      "const FILE_MARKER = true;\nexport { FILE_MARKER };\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(workspace.path, "src", "other.ts"),
      "const FILE_MARKER = false;\n",
      "utf8",
    );
    const tool = createSearchCodeTool();

    const result = await tool.execute(
      tool.parseArguments({
        query: "FILE_MARKER",
        path: "src/app.ts",
        fixedStrings: true,
      }),
      { cwd: workspace.path },
    );

    expect(result).toEqual({
      success: true,
      output:
        "src/app.ts:1: const FILE_MARKER = true;\nsrc/app.ts:2: export { FILE_MARKER };",
      data: {
        query: "FILE_MARKER",
        path: "src/app.ts",
        matches: [
          {
            path: "src/app.ts",
            line: 1,
            text: "const FILE_MARKER = true;",
          },
          {
            path: "src/app.ts",
            line: 2,
            text: "export { FILE_MARKER };",
          },
        ],
        truncated: false,
      },
      commandAction: "search",
    });
  });

  it("returns a successful empty result when there are no matches", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);
    await fs.mkdir(path.join(workspace.path, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace.path, "src", "app.ts"), "export const hello = true;\n", "utf8");
    const tool = createSearchCodeTool();

    const result = await tool.execute(
      tool.parseArguments({ query: "NO_SUCH_MARKER", fixedStrings: true }),
      { cwd: workspace.path },
    );

    expect(result).toEqual({
      success: true,
      output: 'No matches found for "NO_SUCH_MARKER" in workspace.',
      data: {
        query: "NO_SUCH_MARKER",
        path: ".",
        matches: [],
      },
      commandAction: "search",
    });
  });

  it("stops broad ripgrep searches at the requested match limit", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);
    await fs.mkdir(path.join(workspace.path, "src"), { recursive: true });
    await fs.writeFile(
      path.join(workspace.path, "src", "many.txt"),
      Array.from({ length: 30_000 }, (_, index) => `BROAD_MARKER_${index}`).join("\n"),
      "utf8",
    );
    const tool = createSearchCodeTool();

    const result = await tool.execute(
      tool.parseArguments({
        query: "BROAD_MARKER",
        fixedStrings: true,
        limit: 5,
      }),
      { cwd: workspace.path },
    );

    expect(result.success).toBe(true);
    expect(result.data?.matches).toHaveLength(5);
    expect(result.data?.truncated).toBe(true);
    expect(result.output.split("\n")).toHaveLength(5);
  });
});
