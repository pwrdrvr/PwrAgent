import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const step = workflow.split("      - name: Classify changed files\n")[1].split("\n  install-deps:")[0];
const source = step.split("          script: |\n")[1].split("\n").map((line) => line.slice(12)).join("\n");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function classify(files, { event = "pull_request", reportedCount = files.length, lookupError } = {}) {
  const outputs = {};
  let lookupCalls = 0;
  const summary = {
    addHeading() { return this; },
    addTable() { return this; },
    addRaw() { return this; },
    async write() {},
  };
  await new AsyncFunction("core", "context", "github", source)(
    { setOutput: (name, value) => { outputs[name] = value; }, notice() {}, summary },
    { eventName: event, payload: { pull_request: { changed_files: reportedCount } },
      repo: { owner: "fixture", repo: "fixture" }, issue: { number: 1 } },
    { rest: { pulls: { listFiles() {} } }, paginate: async () => {
      lookupCalls++;
      if (lookupError) throw lookupError;
      return files;
    } },
  );
  return { fullCi: outputs.code_impacting === "true", lookupCalls };
}

// The policy model assigns classes to fixture paths. Execute the workflow's
// actual script against every rename direction and every mixed-file pair.
const paths = [
  { path: "docs/operator.json", product: false },
  { path: "README.MD", product: false },
  { path: ".agents/skills/example/SKILL.md", product: false },
  { path: ".agents/skills/example/agents/openai.yaml", product: false },
  { path: ".agents/skills/example/scripts/tool.py", product: false },
  { path: ".agents/skills/example/tests/tool.test.mjs", product: false },
  { path: ".agents/skills-other/tool.py", product: true },
  { path: ".agents/scripts/tool.py", product: true },
  { path: "scripts/tool.test.mjs", product: true },
  { path: ".github/workflows/ci.yml", product: true },
  { path: "apps/desktop/src/main/index.ts", product: true },
  { path: "package.json", product: true },
];

it("matches the policy model for additions, modifications, deletions, renames and mixed changes", async () => {
  for (const current of paths) {
    for (const status of ["added", "modified", "removed"]) {
      expect((await classify([{ filename: current.path, status }])).fullCi,
        `${status}: ${current.path}`).toBe(current.product);
    }
    for (const previous of paths) {
      const expected = current.product || previous.product;
      expect((await classify([{ filename: current.path, previous_filename: previous.path, status: "renamed" }])).fullCi,
        `${previous.path} -> ${current.path}`).toBe(expected);
      expect((await classify([{ filename: current.path }, { filename: previous.path }])).fullCi,
        `${previous.path} + ${current.path}`).toBe(expected);
    }
  }
});

it("fails closed for missing or incomplete provider data", async () => {
  const files = [{ filename: ".agents/skills/example/tool.py" }];
  expect((await classify([])).fullCi).toBe(true);
  expect((await classify(files, { reportedCount: 2 })).fullCi).toBe(true);
  expect((await classify(files, { lookupError: new Error("provider unavailable") })).fullCi).toBe(true);
});

it("always runs full CI for non-PR events without a changed-file lookup", async () => {
  for (const event of ["push", "workflow_dispatch"]) {
    expect(await classify([], { event })).toEqual({ fullCi: true, lookupCalls: 0 });
  }
});
