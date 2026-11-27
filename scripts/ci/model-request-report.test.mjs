import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import report from "./model-request-report.cjs";
import { currentSha, mainSha, result } from "./fixtures/model-request-report.fixture.mjs";

function fixtureApi({ associated = true } = {}) {
  const pull = {
    number: 14, state: "open",
    head: { sha: currentSha, ref: "topic", repo: { id: 2 } },
    base: { sha: mainSha, ref: "main", repo: { id: 1 } },
  };
  const run = {
    event: "pull_request", id: 20, workflow_id: 5, run_number: 6, run_attempt: 1,
    head_sha: currentSha, head_branch: "topic", head_repository: { id: 2, owner: { login: "fork" } },
    pull_requests: associated ? [{ number: 14, base: { sha: mainSha } }] : [],
    conclusion: "success",
  };
  const context = { repo: { owner: "example", repo: "repo" }, payload: { repository: { id: 1 }, workflow_run: run } };
  const outputs = new Map();
  const core = { info: vi.fn(), setOutput: (key, value) => outputs.set(key, value) };
  const withData = (data) => Promise.resolve({ data });
  const artifacts = new Map([[20, 200], [10, 100], [11, 110]]);
  const comments = [];
  const github = {
    paginate: (endpoint, params) => endpoint(params),
    rest: {
      pulls: { get: vi.fn(() => withData(pull)), list: vi.fn(async () => [pull]) },
      actions: {
        listWorkflowRuns: vi.fn(({ head_sha }) => withData({
          workflow_runs: head_sha ? [{ id: 10, head_sha }] : [{ id: 11, head_sha: "c".repeat(40) }],
        })),
        listWorkflowRunArtifacts: vi.fn(({ run_id }) => withData({ artifacts: artifacts.has(run_id)
          ? [{ name: "model-request-results", id: artifacts.get(run_id), size_in_bytes: 400 }]
          : [] })),
      },
      issues: {
        listComments: vi.fn(async () => comments),
        createComment: vi.fn(async ({ body }) => {
          comments.push({ id: 99, user: { login: "github-actions[bot]" }, body });
        }),
        updateComment: vi.fn(async ({ body }) => { comments.at(-1).body = body; }),
      },
    },
  };
  return { github, context, core, outputs, pull, run, artifacts, comments };
}

it("prefers the exact base and falls back to the newest measured push for fork PRs", async () => {
  const associated = fixtureApi();
  await report.resolve(associated);
  expect(associated.outputs.get("baseline_run")).toBe(10);
  expect(associated.outputs.get("exact_base")).toBe(true);
  associated.artifacts.delete(10);
  await report.resolve(associated);
  expect(associated.outputs.get("baseline_run")).toBe(11);
  expect(associated.outputs.get("exact_base")).toBe(false);

  const fork = fixtureApi({ associated: false });
  await report.resolve(fork);
  expect(fork.github.rest.pulls.list).toHaveBeenCalledWith(expect.objectContaining({ head: "fork:topic", base: "main" }));
  expect(fork.outputs.get("pull")).toBe(14);
  expect(fork.outputs.get("baseline_run")).toBe(11);
  fork.outputs.clear();
  fork.pull.head.repo.id = 3;
  await report.resolve(fork);
  expect(fork.outputs.has("pull")).toBe(false);
});

it("skips successful runs without measurements and reports failures without them", async () => {
  const api = fixtureApi();
  api.artifacts.delete(api.run.id);
  await report.resolve(api);
  expect(api.outputs.has("pull")).toBe(false);
  api.run.conclusion = "failure";
  await report.resolve(api);
  expect(api.outputs.get("pull")).toBe(14);
  expect(api.outputs.get("current_artifact")).toBe("");
  expect(api.outputs.get("baseline_artifact")).toBe("");
});

function archiveFixture(directory, body, member = "model-request-result.json") {
  const download = path.join(directory, "download");
  mkdirSync(download, { recursive: true });
  const writeArchive = [
    "import sys",
    "import zipfile",
    "with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as archive:",
    "    archive.writestr(sys.argv[2], sys.stdin.buffer.read())",
  ].join("\n");
  execFileSync("python3", ["-c", writeArchive, path.join(download, "artifact.zip"), member], { input: body });
  return download;
}

it.skipIf(process.platform === "win32")("reads only the expected JSON member and rejects oversized decoded results", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "model-request-archive-"));
  try {
    const valid = JSON.stringify(result(100, 200));
    expect(report.readArtifact(archiveFixture(path.join(root, "valid"), valid))).toEqual(result(100, 200));
    expect(report.readArtifact(archiveFixture(path.join(root, "wrong"), valid, "ignored.json"))).toBeUndefined();
    const oversized = archiveFixture(path.join(root, "oversized"), ` ${" ".repeat(20_000)}${valid}`);
    expect(report.readArtifact(oversized)).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")("updates a single bot comment and rejects stale heads or rerun results", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "model-request-publish-"));
  try {
    const api = fixtureApi();
    api.comments.push({ id: 42, user: { login: "someone-else" }, body: "<!-- pwragent-model-request -->" });
    const missing = { MODEL_REPORT_PULL: "14" };
    const measured = { ...missing, MODEL_REPORT_PR_DIR: archiveFixture(root, JSON.stringify(result(100, 200))) };
    await report.publish(api, missing);
    expect(api.comments).toHaveLength(2);
    expect(api.comments[1].body).toContain("did not produce");
    api.run.run_attempt = 2;
    await report.publish(api, measured);
    expect(api.comments).toHaveLength(2);
    expect(api.comments[1].body).toContain("First turn total body bytes");
    const currentBody = api.comments[1].body;
    api.run.run_attempt = 1;
    await report.publish(api, measured);
    api.run.run_attempt = 3;
    await report.publish(api, missing);
    api.pull.head.sha = "d".repeat(40);
    await report.publish(api, measured);
    expect(api.comments[1].body).toBe(currentBody);
    expect(api.github.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(api.github.rest.issues.updateComment).toHaveBeenCalledTimes(1);
    expect(api.github.rest.issues.updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 99 }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
