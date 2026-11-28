import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import report from "./model-request-report.cjs";
import { currentSha, legacyMcpResult, mainSha, mcpResult, result, runUrl } from "./fixtures/model-request-report.fixture.mjs";

function fixtureApi({ associated = true, eventBase = mainSha, exactBase = mainSha } = {}) {
  const pull = {
    number: 14, state: "open",
    head: { sha: currentSha, ref: "topic", repo: { id: 2 } },
    base: { sha: eventBase, ref: "main", repo: { id: 1 } },
  };
  const run = {
    event: "pull_request", id: 20, workflow_id: 5, run_number: 6, run_attempt: 1,
    head_sha: currentSha, head_branch: "topic", head_repository: { id: 2, owner: { login: "fork" } },
    pull_requests: associated ? [{ number: 14, base: { sha: eventBase } }] : [],
    conclusion: "success",
  };
  const exact = { id: 10, run_attempt: 1, head_sha: exactBase };
  const recent = { id: 11, run_attempt: 1, head_sha: "c".repeat(40) };
  const context = { repo: { owner: "example", repo: "repo" }, payload: { repository: { id: 1 }, workflow_run: run } };
  const core = { info: vi.fn() };
  const withData = (data) => Promise.resolve({ data });
  const artifacts = new Map();
  const downloads = new Map();
  function upload({ id, run_attempt: attempt }, archive, kind = "default") {
    const artifactId = id * 100 + attempt + (kind === "mcp" ? 50 : 0);
    const retained = artifacts.get(id) ?? [];
    const name = kind === "mcp" ? "model-request-mcp-results" : "model-request-results";
    retained.push({ name: `${name}-attempt-${attempt}`, id: artifactId, size_in_bytes: archive.length });
    artifacts.set(id, retained);
    downloads.set(artifactId, archive);
  }
  const comments = [];
  const github = {
    paginate: (endpoint, params) => endpoint(params),
    rest: {
      pulls: { get: vi.fn(() => withData(pull)), list: vi.fn(async () => [pull]) },
      actions: {
        listWorkflowRuns: vi.fn(({ head_sha }) => withData({
          workflow_runs: head_sha ? [exact].filter((candidate) => candidate.head_sha === head_sha) : [recent],
        })),
        // Return retained uploads even when the API call requests one name.
        listWorkflowRunArtifacts: vi.fn(({ run_id }) => withData({ artifacts: artifacts.get(run_id) ?? [] })),
        downloadArtifact: vi.fn(async ({ artifact_id }) => {
          if (!downloads.has(artifact_id)) throw new Error("archive gone");
          return { data: downloads.get(artifact_id) };
        }),
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
  return { github, context, core, pull, run, exact, recent, upload, downloads, comments };
}

function archiveFixture(body, member = "model-request-result.json") {
  const directory = mkdtempSync(path.join(os.tmpdir(), "model-request-archive-"));
  try {
    const archive = path.join(directory, "artifact.zip");
    const writeArchive = [
      "import sys",
      "import zipfile",
      "with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as archive:",
      "    archive.writestr(sys.argv[2], sys.stdin.buffer.read())",
    ].join("\n");
    execFileSync("python3", ["-c", writeArchive, archive, member], { input: body });
    return readFileSync(archive);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it.skipIf(process.platform === "win32")("selects the real first parent of the checked-out merge for associated and fork runs", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "model-request-merge-"));
  try {
    const git = (...args) => execFileSync("git", [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false",
      "-c", "core.hooksPath=.git/disabled-hooks", ...args,
    ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "-b", "main");
    git("commit", "--allow-empty", "-m", "Original base");
    const eventBase = git("rev-parse", "HEAD");
    git("checkout", "-b", "topic");
    git("commit", "--allow-empty", "-m", "PR change");
    git("checkout", "main");
    git("commit", "--allow-empty", "-m", "Main advanced");
    git("merge", "--no-ff", "--no-edit", "topic");
    const exactBase = git("rev-parse", "HEAD^1");
    expect(exactBase).not.toBe(eventBase);
    git("clone", "--depth=1", pathToFileURL(root).href, "shallow");
    const recorded = report.testedMergeBase(path.join(root, "shallow"));
    expect(recorded).toBe(exactBase);

    const prArchive = archiveFixture(JSON.stringify({ ...result(100, 200), baseSha: recorded }));
    const baseArchive = archiveFixture(JSON.stringify(result(100, 200)));
    for (const associated of [true, false]) {
      const api = fixtureApi({ associated, eventBase, exactBase });
      api.upload(api.run, prArchive);
      api.upload(api.exact, baseArchive);
      api.upload(api.recent, baseArchive);
      await report.publish(api);
      expect(api.github.rest.actions.listWorkflowRuns).toHaveBeenCalledWith(expect.objectContaining({ head_sha: exactBase }));
      expect(api.comments[0].body).toContain(runUrl(api.exact.id));
      expect(api.comments[0].body).not.toContain("latest available successful");
      if (!associated) {
        expect(api.github.rest.pulls.list).toHaveBeenCalledWith(expect.objectContaining({ head: "fork:topic", base: "main" }));
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")("tries a recent baseline when the exact archive fails download or validation", async () => {
  const api = fixtureApi();
  api.upload(api.run, archiveFixture(JSON.stringify({ ...result(100, 200), baseSha: mainSha })));
  api.upload(api.exact, archiveFixture(JSON.stringify({ ...result(100, 200), version: 1 })));
  api.upload(api.recent, archiveFixture(JSON.stringify(result(105, 200))));

  await report.publish(api);
  expect(api.comments[0].body).toContain(runUrl(api.recent.id));
  expect(api.comments[0].body).toContain("latest available successful");
  api.downloads.delete(api.exact.id * 100 + api.exact.run_attempt);
  api.comments.length = 0;
  await report.publish(api);
  expect(api.comments[0].body).toContain(runUrl(api.recent.id));
  expect(api.core.info).toHaveBeenCalledWith(expect.stringContaining("Could not read model request artifact"));
});

it("skips successful attempts and reports failed attempts without a matching upload", async () => {
  const api = fixtureApi();
  api.upload(api.run, Buffer.from("retained upload from attempt one"));
  api.run.run_attempt = 2;
  await report.publish(api);
  expect(api.comments).toHaveLength(0);
  api.run.conclusion = "failure";
  await report.publish(api);
  expect(api.comments).toHaveLength(1);
  expect(api.comments[0].body).toContain(`${currentSha} 6 2 missing`);
  expect(api.github.rest.actions.downloadArtifact).not.toHaveBeenCalled();
});

it.skipIf(process.platform === "win32")("reads only the expected JSON member and rejects oversized results", () => {
  const valid = JSON.stringify(result(100, 200));
  const archive = archiveFixture(valid);
  // The REST download returns binary data as an ArrayBuffer.
  expect(report.readArtifact(Uint8Array.from(archive).buffer)).toEqual(result(100, 200));
  expect(report.readArtifact(archiveFixture(valid, "ignored.json"))).toBeUndefined();
  expect(report.readArtifact(archiveFixture(` ${" ".repeat(20_000)}${valid}`))).toBeUndefined();
  expect(report.readArtifact(Buffer.alloc(20_000))).toBeUndefined();
});

it.skipIf(process.platform === "win32")("updates one bot comment, preserving a valid attempt across partial reruns and stale heads", async () => {
  const api = fixtureApi();
  api.comments.push({ id: 42, user: { login: "someone-else" }, body: "<!-- pwragent-model-request -->" });
  api.run.conclusion = "failure";
  await report.publish(api);
  expect(api.comments[1].body).toContain("did not produce");

  const measured = archiveFixture(JSON.stringify({ ...result(100, 200), baseSha: mainSha }));
  api.run.run_attempt = 2;
  api.run.conclusion = "success";
  api.upload(api.run, measured);
  await report.publish(api);
  const currentBody = api.comments[1].body;
  expect(currentBody).toContain(`${currentSha} 6 2 result`);
  expect(currentBody).toContain("First turn total body bytes");

  api.run.run_attempt = 1;
  api.upload(api.run, measured);
  await report.publish(api);
  api.run.run_attempt = 3;
  api.run.conclusion = "failure";
  await report.publish(api);
  api.run.run_attempt = 4;
  api.upload(api.run, measured);
  api.pull.head.sha = "d".repeat(40);
  await report.publish(api);
  expect(api.comments[1].body).toBe(currentBody);
  expect(api.github.rest.issues.createComment).toHaveBeenCalledTimes(1);
  expect(api.github.rest.issues.updateComment).toHaveBeenCalledTimes(1);
  expect(api.github.rest.issues.updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 99 }));
});

it.skipIf(process.platform === "win32")("publishes large-catalog deltas from a legacy main upload and flags missing newer history", async () => {
  const api = fixtureApi();
  const source = mcpResult(100, 350, 220);
  source.results[2].fullSchemasAdvertised[1] = true;
  source.toolUse[0].observed.calls = 4;
  source.toolUse = source.toolUse.slice(0, 1);
  const member = "model-request-mcp-result.json";
  api.upload(api.run, archiveFixture(JSON.stringify({ ...result(100, 200), baseSha: mainSha })));
  api.upload(api.run, archiveFixture(JSON.stringify(source), member), "mcp");
  api.upload(api.exact, archiveFixture(JSON.stringify(result(100, 200))));
  api.upload(api.exact, archiveFixture(JSON.stringify(legacyMcpResult(105, 300, 220)), member), "mcp");
  await report.publish(api);

  const body = api.comments[0].body;
  expect(body).toContain("| Claude | First turn total body bytes | 300 B | 350 B | **+50 B (+16.7%)** | 300 B | ❌ |");
  expect(body).toContain("Antigravity advertised full fixture schemas on the follow-up");
  expect(body).toContain("The selected main run has no Kimi K3 measurement");
  expect(body).toContain("This CI attempt has no tool-use measurement for Claude, Antigravity, Codex · Kimi K3");
  expect(body).toContain("The selected main run has no tool-use measurement for Codex");
  expect(body).toContain("| Codex | Total model calls | — | 4 | — | 3 | ❌ |");

  api.run.run_attempt = 2;
  api.upload(api.run, archiveFixture(JSON.stringify({ ...result(100, 200), baseSha: mainSha })));
  await report.publish(api);
  expect(api.comments[0].body).toContain("This CI attempt has no usable 240-tool measurement");
  expect(api.comments[0].body).not.toContain("**+50 B");
});

it("reports Antigravity catalog deltas across routes and compares scripted calls within one route", () => {
  const native = { ...mcpResult(100, 200, 240), version: 3, antigravityNative: true };
  native.results[2].fullSchemasAdvertised = [true, true];
  const gateway = { ...mcpResult(100, 200, 140), version: 3, antigravityNative: false };
  const render = (currentMcp, baselineMcp) => report.renderComment({
    current: result(100, 200), baseline: result(100, 200),
    currentMcp, baselineMcp, source: { sha: currentSha, id: 20, number: 6, attempt: 1, conclusion: "success" },
    baselineRun: { id: 10, sha: mainSha }, exactBase: true, runUrl,
  });

  expect(report.validateMcpResult(native)).toBe(native);
  expect(report.validateMcpResult(gateway)).toBe(gateway);
  expect(report.validateMcpResult({ ...native, antigravityNative: "@owner" })).toBeUndefined();
  const nativeComment = render(native, native);
  expect(nativeComment).toContain("Antigravity uses native stdio and is expected to advertise a subset");
  expect(nativeComment).not.toContain("❌ Antigravity advertised");
  expect(nativeComment).toContain("| Antigravity | Model calls after tool results | 2 | 2 | 0 |");

  const gatewayComment = render(gateway, native);
  expect(gatewayComment).toContain("| Antigravity | First turn total body bytes | 240 B | 140 B | −100 B");
  expect(gatewayComment).toContain("Antigravity used a different MCP route");
  expect(gatewayComment).toContain("| Antigravity | Model calls after tool results | — | 2 | — |");
  expect(gatewayComment).toContain("| Claude | Model calls after tool results | 2 | 2 | 0 |");

  gateway.results[2].fullSchemasAdvertised[0] = true;
  expect(render(gateway, native)).toContain("❌ Antigravity advertised full fixture schemas on the first turn.");
});
