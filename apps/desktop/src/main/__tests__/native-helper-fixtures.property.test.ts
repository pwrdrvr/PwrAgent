import { existsSync } from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestProject, TestSpecification } from "vitest/node";
import setup from "../../test-setup/native-helper-fixtures";
import { runNativeFixtureCommand } from "../../test-setup/native-helper-fixture";

vi.mock("../../test-setup/native-helper-fixture", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../test-setup/native-helper-fixture")>(),
  runNativeFixtureCommand: vi.fn(),
}));

const files = [
  path.resolve("apps/desktop/src/main/__tests__/maintenance-cargo-output.property.test.ts"),
  path.resolve("apps/desktop/src/main/__tests__/mcp-ipc-http.test.ts"),
  path.resolve("apps/desktop/src/main/__tests__/unrelated.test.ts"),
];

function projectFixture(selected: string[], lane: string[]) {
  const provide = vi.fn();
  const rerun = vi.fn();
  const project = {
    vitest: {
      config: {
        shard: { index: 1, count: 2 },
        sequence: { sequencer: class {
          shard(specs: TestSpecification[]) { return specs.filter((spec) => lane.includes(spec.moduleId)); }
        } },
      },
      state: { getPaths: () => selected },
      getModuleSpecifications: (moduleId: string) => [{ moduleId, project }],
    },
    provide,
    onTestsRerun: rerun,
  } as unknown as TestProject;
  return { project, provide, rerun };
}

describe("native helper preparation", () => {
  beforeEach(() => { vi.spyOn(console, "info").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  // The chosen lane is the selection oracle. Every selected consumer owns a
  // distinct directory; other files and other lanes must invoke no compiler.
  it("prepares exactly the consumers in the selected shard and removes only its outputs", async () => {
    await fc.assert(fc.asyncProperty(fc.subarray(files), fc.subarray(files), async (selected, lane) => {
      const roots: string[] = [];
      vi.mocked(runNativeFixtureCommand).mockImplementation(async (_command, args) => { roots.push(args.at(-1)!); });
      const { project, provide, rerun } = projectFixture(selected, lane);
      const dispose = await setup(project);
      try {
        const expected = files.slice(0, 2).filter((file) => selected.includes(file) && lane.includes(file));
        expect(roots).toHaveLength(expected.length);
        expect(new Set(roots).size).toBe(roots.length);
        expect(roots.every((root) => existsSync(root))).toBe(true);
        const helpers = provide.mock.calls.at(-1)![1];
        expect(Boolean(helpers.maintenanceCargo)).toBe(expected.includes(files[0]));
        expect(Boolean(helpers.mcpIpc)).toBe(expected.includes(files[1]));
        if (helpers.maintenanceCargo) expect(helpers.maintenanceCargo.identity).toBeUndefined();
        if (helpers.mcpIpc) expect(helpers.mcpIpc.identity).toBeDefined();
        // A later selection in this test invocation can acquire the other
        // fixture, without rebuilding one already prepared.
        await rerun.mock.calls[0][0](files.map((moduleId) => ({ moduleId, project })));
        expect(roots).toHaveLength(files.slice(0, 2).filter((file) => lane.includes(file)).length);
      } finally { await dispose(); }
      expect(roots.every((root) => !existsSync(root))).toBe(true);
    }), { numRuns: 20 });
  });

  it("drains a sibling compiler before cleaning up a failed preparation phase", async () => {
    const roots: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const failure = new Error("controlled build failure");
    vi.mocked(runNativeFixtureCommand).mockImplementation(async (_command, args) => {
      roots.push(args.at(-1)!);
      if (roots.length === 1) throw failure;
      await gate;
    });
    const { project, provide } = projectFixture(files, files);
    let settled = false;
    const preparation = setup(project).catch((error: unknown) => error).finally(() => { settled = true; });
    try {
      await setImmediate();
      expect(roots).toHaveLength(2);
      expect(settled).toBe(false);
      expect(roots[1] && existsSync(roots[1])).toBe(true);
      expect(provide).not.toHaveBeenCalled();
    } finally { release(); await preparation; }
    expect(await preparation).toBe(failure);
    expect(roots.every((root) => !existsSync(root))).toBe(true);
  });
});
