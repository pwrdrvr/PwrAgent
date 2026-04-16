import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalToolExecutor } from "../tools/tool-execution.js";
import { createDefaultToolRegistry } from "../tools/tool-registry.js";
import { createTemporaryTestDirectory } from "../testing/test-harness.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("tool registry", () => {
  it("exposes the initial read-only tool set", () => {
    const executor = new LocalToolExecutor(createDefaultToolRegistry());

    expect(executor.listTools()).toEqual([
      expect.objectContaining({
        name: "read_file",
        readOnly: true,
      }),
      expect.objectContaining({
        name: "list_files",
        readOnly: true,
      }),
      expect.objectContaining({
        name: "search_code",
        readOnly: true,
      }),
      expect.objectContaining({
        name: "write_file",
        readOnly: false,
      }),
      expect.objectContaining({
        name: "edit_file",
        readOnly: false,
      }),
      expect.objectContaining({
        name: "shell_command",
        readOnly: false,
      }),
    ]);
  });

  it("returns normalized execution metadata for valid tool invocations", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);
    await fs.mkdir(path.join(workspace.path, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace.path, "src", "app.ts"), "export const marker = 1;\n", "utf8");
    const executor = new LocalToolExecutor(createDefaultToolRegistry());

    const result = await executor.executeTool(
      {
        name: "list_files",
        arguments: { path: "src" },
      },
      { cwd: workspace.path },
    );

    expect(result).toEqual({
      toolName: "list_files",
      arguments: { path: "src" },
      success: true,
      output: "src/app.ts",
      data: {
        path: "src",
        files: ["src/app.ts"],
        truncated: false,
      },
      commandAction: "listFiles",
      item: {
        type: "dynamicToolCall",
        text: "src/app.ts",
        toolName: "list_files",
        success: true,
        arguments: { path: "src" },
        commandAction: "listFiles",
      },
    });
  });

  it("fails validation before execution with stable error text", async () => {
    const executor = new LocalToolExecutor(createDefaultToolRegistry());

    const result = await executor.executeTool(
      {
        name: "read_file",
        arguments: { path: 42 },
      },
      { cwd: "/repo" },
    );

    expect(result).toEqual({
      toolName: "read_file",
      arguments: { path: 42 },
      success: false,
      output: 'Invalid arguments for read_file: "path" must be a non-empty string',
      errorCode: "invalid_arguments",
      item: {
        type: "dynamicToolCall",
        text: 'Invalid arguments for read_file: "path" must be a non-empty string',
        toolName: "read_file",
        success: false,
        arguments: { path: 42 },
      },
    });
  });

  it("returns a deterministic error for unknown tools", async () => {
    const executor = new LocalToolExecutor(createDefaultToolRegistry());

    const result = await executor.executeTool(
      {
        name: "missing_tool",
        arguments: { query: "x" },
      },
      { cwd: "/repo" },
    );

    expect(result).toEqual({
      toolName: "missing_tool",
      arguments: { query: "x" },
      success: false,
      output: "Unknown tool: missing_tool",
      errorCode: "unknown_tool",
      item: {
        type: "dynamicToolCall",
        text: "Unknown tool: missing_tool",
        toolName: "missing_tool",
        success: false,
        arguments: { query: "x" },
      },
    });
  });
});
