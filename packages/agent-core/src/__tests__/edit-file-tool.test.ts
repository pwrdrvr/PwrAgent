import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditFileTool } from "../tools/edit-file-tool.js";
import { createTemporaryTestDirectory } from "../testing/test-harness.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("edit_file tool", () => {
  it("rejects non-unique edit anchors", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);
    await fs.mkdir(path.join(workspace.path, "src"), { recursive: true });
    await fs.writeFile(
      path.join(workspace.path, "src", "demo.ts"),
      "const value = 1;\nconst value = 2;\n",
      "utf8",
    );
    const tool = createEditFileTool();

    await expect(
      tool.execute(
        tool.parseArguments({
          path: "src/demo.ts",
          oldString: "const value",
          newString: "const answer",
        }),
        { cwd: workspace.path, approvalPolicy: "never" },
      ),
    ).rejects.toThrow(/oldString is not unique/);
  });

  it("edits a unique anchor after approval", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);
    await fs.mkdir(path.join(workspace.path, "src"), { recursive: true });
    await fs.writeFile(
      path.join(workspace.path, "src", "demo.ts"),
      "const value = 1;\n",
      "utf8",
    );
    const tool = createEditFileTool();
    const requestApproval = vi.fn(async () => ({ decision: "approve" }));

    const result = await tool.execute(
      tool.parseArguments({
        path: "src/demo.ts",
        oldString: "const value = 1;",
        newString: "",
      }),
      {
        cwd: workspace.path,
        approvalPolicy: "on-request",
        requestApproval,
      },
    );

    expect(await fs.readFile(path.join(workspace.path, "src", "demo.ts"), "utf8")).toBe("\n");
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "fileChange",
        path: "src/demo.ts",
      }),
    );
    expect(result).toEqual({
      success: true,
      output: "Edited src/demo.ts.",
      data: {
        path: "src/demo.ts",
        replacements: 1,
      },
    });
  });
});
