import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { expect, it, vi } from "vitest";
import fc from "fast-check";
import { applyLocalCodexEnvironmentSelection } from "../app-server/codex-environment-runtime";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(),
}));
vi.mock("../log", () => ({
  getMainLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

type Chunk = { stream: "stdout" | "stderr"; text: string };
const chunks = fc.array(fc.record({
  stream: fc.constantFrom("stdout" as const, "stderr" as const),
  text: fc.string({ maxLength: 24 }),
}), { maxLength: 30 });

async function replay(arrivals: Chunk[], exitCode: number) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcess);
  const progress: Chunk[] = [];
  const running = applyLocalCodexEnvironmentSelection({
    env: {}, setupTimeoutMs: 0,
    selection: {
      executionTarget: "local", runSetup: true,
      environment: { id: "env", name: "Environment", sourcePath: "environment.toml",
        shell: "powershell", setupScript: "fixture-command", actions: [] },
    },
    onSetupProgress: ({ phase, chunk }) => {
      if (phase === "stdout" || phase === "stderr") progress.push({ stream: phase, text: chunk! });
    },
  });
  // The real runtime installs its listeners synchronously. These data events
  // are the independent arrival ledger, not two separately grouped streams.
  for (const arrival of arrivals) {
    child[arrival.stream].emit("data", Buffer.from(arrival.text));
    expect(progress).toEqual(arrivals.slice(0, progress.length));
  }
  child.emit("close", exitCode, null);
  const runtime = await running.catch((error: unknown) => {
    expect(error).toHaveProperty("runtime");
    return (error as { runtime: Awaited<typeof running> }).runtime;
  });
  expect(runtime?.setupExitCode).toBe(exitCode);
  expect(runtime?.setupStatus).toBe(exitCode === 0 ? "completed" : "failed");
  expect(runtime?.setupOutput).toBe(arrivals.map(({ text }) => text).join("").trimEnd());
  expect(progress).toEqual(arrivals);
}

it("retains the arrival ledger across both streams and arbitrary chunk boundaries on success or failure", async () => {
  // #613 promises the output a terminal would show, with no stream grouping
  // or invented separators. Model runs exercise the actual command runtime.
  await fc.assert(fc.asyncProperty(chunks, fc.constantFrom(0, 1), replay), { numRuns: 50 });
});

it.each([0, 1])("keeps a stderr space before later stdout (shrunk #613 regression, exit %i)", async (exitCode) => {
  await replay([{ stream: "stderr", text: " " }, { stream: "stdout", text: "!" }], exitCode);
});

it("does not move an earlier stderr line behind later stdout", async () => {
  await replay([{ stream: "stderr", text: "before\n" }, { stream: "stdout", text: "after\n" }], 0);
});
