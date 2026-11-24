import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ThreadDependency,
  ThreadDependencyCiRunObservation,
  ThreadDependencyCiRunOutcome,
  ThreadDependencyCondition,
  ThreadDependencyEvidence,
} from "@pwragent/shared/contracts/thread-dependencies";
import { summarizeThreadDependencyPrompt } from "@pwragent/shared/contracts/thread-system-messages";
import {
  threadDependencyCiRunId,
  threadDependencyCiRunOutcomes,
} from "@pwragent/shared/contracts/thread-dependencies";
import { DEFAULT_GITHUB_ENTERPRISE_HOSTS, applyDesktopSettingsPatch, desktopSettingsPatchToEdits, parseDesktopSettingsToml, readDesktopSettingsConfig } from "../settings/desktop-config";
import { applyTomlEdits, parseTomlTables } from "../settings/toml-editor";
import { StateDb } from "../state/state-db";
import { ThreadDependencyStore } from "../state/thread-dependency-store";
import { ThreadDependencyCoordinator, buildDependencyPrompt } from "../app-server/thread-dependency-coordinator";
import {
  CI_RUN_GONE_CHECKS, CI_RUN_STREAK_GAP_MS, CI_RUN_UNREADABLE_MS, ThreadDependencyCiRunPoller, ciApprovalsForDependency, evaluateCiRunCondition, mergeCiRunCheck,
  normalizeGithubEnterpriseHosts, parseCiRunUrl, readCiRun,
} from "../app-server/thread-dependency-ci-runs";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { measureSqliteWrites } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

const RUN_URL = "https://github.com/example/app/actions/runs/8841207733";
const PIPELINE_URL = "https://gitlab.com/example/platform/app/-/pipelines/901";
const GHES_URL = "https://github.example.com/example/app/actions/runs/77";

const ciRunCondition = (ciRun: ThreadDependencyCondition["ciRun"] = { url: RUN_URL }): ThreadDependencyCondition =>
  ({ backend: "codex", threadId: "", when: "ci_run", ciRun });

const observation = (patch: Partial<ThreadDependencyCiRunObservation> = {}): ThreadDependencyCiRunObservation => ({
  runId: 8841207733, name: "Release", status: "in_progress", attempt: 1, headSha: "3f9c02e1aa",
  jobs: { total: 5, passed: 2, failed: 0, running: 1, queued: 2, waiting: 0, skipped: 0 }, checkedAt: 1,
  ...patch,
});

const SUCCEEDED = new Set(["success", "neutral", "skipped"]);

/**
 * The rule, stated independently of the implementation: what one check
 * means for a wait that has not fired yet.
 */
function oracle(on: readonly ThreadDependencyCiRunOutcome[], environments: readonly string[] | undefined, seen: ThreadDependencyCiRunObservation):
  "waiting" | "satisfied" | "failed" {
  if (seen.error) return "waiting";
  const gateMatches = (seen.gates ?? []).some((gate) => !environments?.length
    || environments.some((name) => name.toLowerCase() === gate.environment.toLowerCase()));
  if (seen.status === "completed") {
    if (!SUCCEEDED.has(seen.conclusion ?? "")) return "failed";
    // A pass is the finish when asked for; otherwise a gate still open on it (GitLab) counts.
    return on.includes("finished") || on.includes("approval_gate") && gateMatches ? "satisfied" : "failed";
  }
  if (on.includes("job_failed") && (seen.failedJobs?.length ?? 0) > 0) return "failed";
  if (on.includes("approval_gate") && seen.status === "waiting" && gateMatches) return "satisfied";
  return "waiting";
}

const outcomesArb = fc.option(fc.subarray(["approval_gate", "job_failed", "finished"] as ThreadDependencyCiRunOutcome[], { minLength: 1 }), { nil: undefined });
const environmentsArb = fc.option(fc.subarray(["windows-signing", "Production", "staging"], { minLength: 1 }), { nil: undefined });
const observationArb: fc.Arbitrary<ThreadDependencyCiRunObservation> = fc.record({
  status: fc.constantFrom("queued", "in_progress", "waiting", "completed"),
  conclusion: fc.constantFrom(undefined, "success", "failure", "cancelled", "neutral", "skipped", "timed_out"),
  gates: fc.array(fc.record({ environment: fc.constantFrom("windows-signing", "production", "macos-notarize"), reviewers: fc.constant<string[]>(["release-team"]) }), { maxLength: 2 }),
  failed: fc.nat({ max: 2 }),
  passed: fc.nat({ max: 20 }),
  running: fc.nat({ max: 20 }),
  error: fc.boolean(),
  checkedAt: fc.nat({ max: 1_000_000 }),
}).map(({ status, conclusion, gates, failed, passed, running, error, checkedAt }) => observation({
  status, ...(conclusion ? { conclusion } : {}), gates,
  jobs: { total: passed + running + failed, passed, failed, running, queued: 0, waiting: 0, skipped: 0 },
  ...(failed ? { failedJobs: Array.from({ length: failed }, (_, index) => ({ name: `Job ${index}`, url: RUN_URL })) } : {}),
  ...(error ? { error: "rate limited" } : {}),
  checkedAt,
}));

describe("CI run prerequisite evaluation", () => {
  it("projects only the signing environments that satisfied a delivered GitHub reminder", () => {
    const environments = ["windows-signing", "apple-signing", "production"];
    fc.assert(fc.property(
      fc.subarray(environments, { minLength: 1 }),
      fc.subarray(environments),
      outcomesArb,
      fc.constantFrom("waiting", "completed"),
      fc.constantFrom("ready", "delivered"),
      fc.subarray(environments),
      (pending, filter, on, runStatus, dependencyStatus, timerOnly) => {
        const condition = ciRunCondition({ url: RUN_URL, on, environments: filter.map((name) => name.toUpperCase()) });
        const check = observation({
          status: runStatus,
          conclusion: runStatus === "completed" ? "success" : undefined,
          // Older deliveries saved every pending environment, including timer-only waits.
          gates: runStatus === "waiting" ? pending.map((environment) => timerOnly.includes(environment)
            ? { environment, reviewers: [], waitTimerMinutes: 10 }
            : { environment, reviewers: ["release-team"] }) : [],
        });
        const evidence = evaluateCiRunCondition(condition, check, undefined, check.checkedAt);
        if (evidence.state === "waiting") return;
        const dependency: ThreadDependency = {
          id: "watch", backend: "codex", threadId: "release-thread", conditions: [condition],
          mode: "all", onFailure: "notify", continuation: "Review signing", deliver: "operator",
          status: dependencyStatus, outcome: evidence.state === "satisfied" ? "success" : "failure",
          evidence: [evidence], createdAt: 0, updatedAt: check.checkedAt,
        };
        const expected = dependencyStatus === "delivered" && runStatus === "waiting" && (!on || on.includes("approval_gate"))
          ? pending.filter((name) => !timerOnly.includes(name) && (filter.length === 0 || filter.includes(name))) : [];
        const approvals = ciApprovalsForDependency(dependency);
        expect(approvals.map(({ url, environments }) => ({ url, environments })))
          .toEqual(expected.length > 0 ? [{ url: RUN_URL, environments: expected }] : []);
      },
    ));
  });

  it("fires once on the first check the oracle accepts and never changes after", () => {
    fc.assert(fc.property(outcomesArb, environmentsArb, fc.array(observationArb, { maxLength: 12 }), (on, environments, checks) => {
      const condition = ciRunCondition({ url: RUN_URL, ...(on ? { on } : {}), ...(environments && (!on || on.includes("approval_gate")) ? { environments } : {}) });
      const wanted = threadDependencyCiRunOutcomes(condition.ciRun!);
      let previous: ThreadDependencyEvidence | undefined;
      let fired: ThreadDependencyEvidence | undefined;
      for (const [index, seen] of checks.entries()) {
        const evidence = evaluateCiRunCondition(condition, seen, previous, index);
        const expected = fired ? fired.state : oracle(wanted, condition.ciRun!.environments, seen);
        expect(evidence.state).toBe(expected);
        if (fired) expect(evidence).toBe(fired);
        if (!fired && evidence.state !== "waiting") {
          fired = evidence;
          // The fired evidence carries the check that fired it, for the wake.
          expect(evidence.ciRun).toBe(seen);
        }
        previous = evidence;
      }
    }));
  });

  it("gives up on a run that is gone or unreadable for a day, and waits through passing failures", () => {
    // Raw check results: a readable run with no milestone yet, or a failure with a forge code.
    const checkArb = fc.record({
      gapMs: fc.constantFrom(30_000, 120_000, 14 * 60_000, 16 * 60_000, 9 * 60 * 60_000),
      failure: fc.constantFrom(undefined, "not_found", "rate_limited", "forbidden", "unauthenticated"),
    });
    fc.assert(fc.property(fc.array(checkArb, { maxLength: 30 }), (checks) => {
      const condition = ciRunCondition();
      let at = 0;
      let merged: ThreadDependencyCiRunObservation | undefined;
      let previous: ThreadDependencyEvidence | undefined;
      // The rule, kept separately: count consecutive 404s, and time any unbroken run of failures.
      let notFound = 0;
      let failingSince: number | undefined;
      let expected: "waiting" | "failed" = "waiting";
      for (const check of checks) {
        at += check.gapMs;
        const seen = check.failure
          ? { runId: 8841207733, status: "unknown", error: `GitHub said ${check.failure}`, errorCode: check.failure, checkedAt: at }
          : observation({ checkedAt: at });
        // Unchecked time (sleep, a paused project) never counts toward giving up.
        if (check.gapMs > CI_RUN_STREAK_GAP_MS) { notFound = 0; failingSince = undefined; }
        notFound = check.failure === "not_found" ? notFound + 1 : 0;
        failingSince = check.failure ? failingSince ?? at : undefined;
        if (expected === "waiting" && check.failure && (notFound >= CI_RUN_GONE_CHECKS || at - failingSince! >= CI_RUN_UNREADABLE_MS)) expected = "failed";
        merged = mergeCiRunCheck(merged, seen);
        previous = evaluateCiRunCondition(condition, merged, previous, at);
        expect(previous.state).toBe(expected);
      }
    }));
  });

  it("gives up after a day of failed checks, but not across a sleep between two failures", () => {
    const condition = ciRunCondition();
    const failed = (checkedAt: number) => ({ runId: 8841207733, status: "unknown", error: "GitHub returned HTTP 403.", errorCode: "forbidden", checkedAt });
    let merged: ThreadDependencyCiRunObservation | undefined;
    let evidence: ThreadDependencyEvidence | undefined;
    for (let at = 0; at <= CI_RUN_UNREADABLE_MS; at += 120_000) {
      merged = mergeCiRunCheck(merged, failed(at));
      evidence = evaluateCiRunCondition(condition, merged, evidence, at);
    }
    expect(evidence).toMatchObject({ state: "failed", reason: "Run could not be read for 24 hours: GitHub returned HTTP 403." });
    // The lid closes on a failed check and opens 60 hours later on another.
    const slept = mergeCiRunCheck(mergeCiRunCheck(undefined, failed(0)), failed(60 * 60 * 60_000));
    expect(evaluateCiRunCondition(condition, slept, undefined, 0).state).toBe("waiting");
  });

  it("never leaves a finished run waiting", () => {
    fc.assert(fc.property(outcomesArb, observationArb, (on, seen) => {
      fc.pre(seen.status === "completed" && !seen.error);
      expect(evaluateCiRunCondition(ciRunCondition({ url: RUN_URL, ...(on ? { on } : {}) }), seen, undefined, 0).state).not.toBe("waiting");
    }));
  });

  it("gives every waiting check the same evidence, so checks write nothing", () => {
    fc.assert(fc.property(outcomesArb, fc.array(observationArb, { minLength: 2, maxLength: 12 }), (on, checks) => {
      const condition = ciRunCondition({ url: RUN_URL, ...(on ? { on } : {}) });
      const waiting = checks.map((seen, index) => evaluateCiRunCondition(condition, seen, undefined, index))
        .filter((evidence) => evidence.state === "waiting")
        .map((evidence) => JSON.stringify({ ...evidence, observedAt: 0 }));
      expect(new Set(waiting).size).toBeLessThanOrEqual(1);
    }));
  });
});

describe("CI run URLs", () => {
  it("accepts github.com Actions runs and normalizes attempts away", () => {
    expect(parseCiRunUrl(`${RUN_URL}/attempts/2`)).toMatchObject({ runId: 8841207733, url: RUN_URL, repository: { owner: "example", repo: "app", host: "github.com" } });
    expect(parseCiRunUrl(`${RUN_URL}/`)?.url).toBe(RUN_URL);
  });

  it("accepts gitlab.com pipelines at any subgroup depth", () => {
    expect(parseCiRunUrl(`${PIPELINE_URL}/`)).toEqual({ runId: 901, url: PIPELINE_URL, repository: { provider: "gitlab", host: "gitlab.com", owner: "example/platform", repo: "app" } });
    expect(parseCiRunUrl("https://gitlab.com/example/app/-/pipelines/5")?.repository).toMatchObject({ owner: "example", repo: "app" });
    for (const url of [
      "https://gitlab.com/app/-/pipelines/5",
      "https://gitlab.com/example/app/-/pipelines/0",
      "https://gitlab.com/example/app/-/jobs/5",
      "https://gitlab.com/example/app/actions/runs/5",
      "https://gitlab.example.com/example/app/-/pipelines/5",
      "https://github.com/example/app/-/pipelines/5",
    ]) expect(parseCiRunUrl(url, { githubEnterpriseHosts: ["gitlab.example.com"] })).toBeUndefined();
  });

  it("accepts a GitHub Enterprise run only on a host the operator listed, matched exactly", () => {
    // Entries an operator might write, a URL host an agent might supply: accepted only on equality.
    const entryArb = fc.constantFrom("github.example.com", "GitHub.Example.com ", "ghe.internal.example:8443", "*.example.com", ".example.com", "example.com",
      "https://github.example.com", "github.example.com/api", "github.com", "gitlab.com", "localhost", "", "ghe internal");
    const hostArb = fc.constantFrom("github.example.com", "ghe.internal.example:8443", "ghe.internal.example", "evil.github.example.com", "github.example.com.evil.test",
      "example.com", "a.example.com", "notgithub.example.com", "localhost", "gitlab.com");
    const valid = new Set(["github.example.com", "ghe.internal.example:8443", "example.com"]);
    fc.assert(fc.property(fc.array(entryArb, { maxLength: 6 }), hostArb, (entries, host) => {
      const listed = new Set(entries.map((entry) => entry.trim().toLowerCase()).filter((entry) => valid.has(entry)));
      expect(new Set(normalizeGithubEnterpriseHosts(entries))).toEqual(listed);
      const ref = parseCiRunUrl(`https://${host}/example/app/actions/runs/77`, { githubEnterpriseHosts: entries });
      expect(ref !== undefined).toBe(listed.has(host));
      if (ref) expect(ref).toMatchObject({ url: `https://${host}/example/app/actions/runs/77`, repository: { provider: "github", host } });
    }));
    expect(parseCiRunUrl(GHES_URL)).toBeUndefined();
    expect(normalizeGithubEnterpriseHosts(Array.from({ length: 40 }, (_, index) => `ghe${index}.example.com`))).toHaveLength(16);
    expect(normalizeGithubEnterpriseHosts([7, null, "github.example.com"])).toEqual(["github.example.com"]);
    // A URL's host never carries the default port, so an entry written with it still matches.
    expect(parseCiRunUrl("https://github.example.com:443/example/app/actions/runs/77", { githubEnterpriseHosts: ["github.example.com:443"] })?.url).toBe(GHES_URL);
  });

  it("reads the authorized hosts from [git] github_enterprise_hosts in config.toml", () => {
    const dir = mkdtempSync(join(tmpdir(), "pwragent-ci-run-hosts-"));
    try {
      const configPath = join(dir, "config.toml");
      writeFileSync(configPath, '[git]\ngithub_enterprise_hosts = ["github.example.com", "*.example.com"]\n');
      const hosts = readDesktopSettingsConfig(configPath).git?.githubEnterpriseHosts?.value;
      expect(hosts).toEqual(["github.example.com", "*.example.com"]);
      expect(parseCiRunUrl(GHES_URL, { githubEnterpriseHosts: hosts })?.url).toBe(GHES_URL);
      expect(parseCiRunUrl("https://ghe.example.com/example/app/actions/runs/77", { githubEnterpriseHosts: hosts })).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("replaces the exact hosts admitted by CI waits through the settings patch", () => {
    const existing = '[git]\n# Only internal hosts\ngithub_enterprise_hosts = ["old.example.com", "*.example.com"]\nwatch_merge_builds = false\n';
    const tables = parseTomlTables(existing, "test.toml");
    const expectedRevision = parseDesktopSettingsToml(existing, "test.toml").git!.githubEnterpriseHosts!.revision;
    const host = fc.nat().map((id) => `ghe${id}.example.com:8443`);
    fc.assert(fc.property(fc.uniqueArray(host, { maxLength: 16, size: "max" }), (hosts) => {
      const edited = applyTomlEdits(existing, desktopSettingsPatchToEdits(
        { git: { githubEnterpriseHosts: { hosts, expectedRevision } } }, tables,
      ));
      expect(edited).toContain("# Only internal hosts");
      const config = parseDesktopSettingsToml(edited, "test.toml");
      expect(config.git?.watchMergeBuilds).toBe(false);
      const options = { githubEnterpriseHosts: config.git?.githubEnterpriseHosts?.value };
      expect(options.githubEnterpriseHosts).toEqual(hosts);
      for (const exact of hosts) {
        expect(parseCiRunUrl(`https://${exact}/example/app/actions/runs/77`, options)?.repository.host).toBe(exact);
        expect(parseCiRunUrl(`https://sub.${exact}/example/app/actions/runs/77`, options)).toBeUndefined();
      }
      expect(parseCiRunUrl("https://old.example.com/example/app/actions/runs/77", options)).toBeUndefined();
    }));
  });

  it("rejects settings patches that would silently ignore invalid or excess hosts", () => {
    const expectedRevision = DEFAULT_GITHUB_ENTERPRISE_HOSTS.revision;
    // The editor shows no line numbers, so each rejection quotes the entry and its reason.
    const invalid = fc.constantFrom(
      ["*.example.com", "uses a wildcard"], ["https://git.example.com", "is a URL"], ["git.example.com/path", "includes a path"],
      ["git.example.com:65536", "is not a hostname"], ["GitHub.com", "is not a GitHub Enterprise host"],
    );
    fc.assert(fc.property(invalid, ([host, reason]) => {
      expect(() => desktopSettingsPatchToEdits({
        git: { githubEnterpriseHosts: { hosts: ["git.example.com", host], expectedRevision } },
      })).toThrow(`Line 2 (${host}) ${reason}. Enter exact hostnames with an optional port.`);
    }));
    expect(() => desktopSettingsPatchToEdits({
      git: { githubEnterpriseHosts: { hosts: Array.from({ length: 17 }, (_, i) => `ghe${i}.example.com`), expectedRevision } },
    })).toThrow(/up to 16 distinct hosts/);
  });

  it("rejects a draft that would restore a host removed on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "pwragent-ci-run-conflict-"));
    try {
      const configPath = join(dir, "config.toml");
      fc.assert(fc.property(fc.uniqueArray(fc.nat(), { minLength: 2, maxLength: 3 }), (ids) => {
        const [revoked, added, retained] = ids.map((id) => `ghe${id}.example.com`);
        const saved = retained ? [revoked!, retained] : [revoked!];
        writeFileSync(configPath, `[git]\ngithub_enterprise_hosts = ${JSON.stringify(saved)}\n`);
        const expectedRevision = readDesktopSettingsConfig(configPath).git!.githubEnterpriseHosts!.revision;
        const changed = `[git]\ngithub_enterprise_hosts = ${JSON.stringify(saved.slice(1))}\n`;
        writeFileSync(configPath, changed);
        expect(() => applyDesktopSettingsPatch(configPath, {
          git: { githubEnterpriseHosts: { hosts: [...saved, added!], expectedRevision } },
        })).toThrow(/GitHub Enterprise hosts changed/);
        expect(readFileSync(configPath, "utf8")).toBe(changed);
      }), { numRuns: 30 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("names the run by the id at the end of its URL", () => {
    expect(threadDependencyCiRunId(RUN_URL)).toBe("8841207733");
    expect(threadDependencyCiRunId(`${RUN_URL}/attempts/2`)).toBe("8841207733");
    expect(threadDependencyCiRunId(PIPELINE_URL)).toBe("901");
    // A namespace can spell another run path; the pipeline id is still the last one.
    expect(threadDependencyCiRunId("https://gitlab.com/actions/runs/5/app/-/pipelines/901")).toBe("901");
    expect(threadDependencyCiRunId("https://github.com/example/app/pull/12")).toBeUndefined();
  });

  it("refuses other hosts, plain http, credentials and non-run pages", () => {
    for (const url of [
      "http://github.com/example/app/actions/runs/1",
      "https://github.example.com/example/app/actions/runs/1",
      "https://token@github.com/example/app/actions/runs/1",
      "https://github.com/example/app/pull/12",
      "https://github.com/example/app/actions/runs/1/job/2",
      "https://github.com/example/app/actions/runs/0",
      "not a url",
    ]) expect(parseCiRunUrl(url)).toBeUndefined();
  });
});

describe("reading a run", () => {
  it("counts the latest attempt's jobs, names failed steps, and reads gates only while the run waits", async () => {
    const get = vi.fn(async (_repository: unknown, path: string): Promise<unknown> => {
      if (path.endsWith("/pending_deployments")) {
        return [
          { environment: { name: "cooldown" }, wait_timer: 10, reviewers: [] },
          { environment: { id: 4410, name: "windows-signing" }, wait_timer: 5, reviewers: [
            { type: "Team", reviewer: { slug: "release-team", name: "Release Team" } },
            { type: "User", reviewer: { login: "octo-maintainer" } },
          ] },
        ];
      }
      if (path.includes("/jobs?")) {
        return { jobs: [
          { id: 1, name: "Prepare signing input", status: "completed", conclusion: "success" },
          { id: 2, name: "macOS tests", status: "completed", conclusion: "failure", html_url: "https://github.com/example/app/actions/runs/8841207733/job/2",
            steps: [{ name: "Checkout", conclusion: "success" }, { name: "Unit tests\u0007", conclusion: "failure" }] },
          { id: 3, name: "Windows signing", status: "waiting", conclusion: null },
          { id: 4, name: "Publish", status: "queued", conclusion: null },
          { id: 5, name: "Lint", status: "in_progress", conclusion: null },
        ] };
      }
      return { id: 8841207733, name: "Release", status: "waiting", conclusion: null, run_attempt: 1, head_sha: "3f9c02e1aa", head_branch: "v2.4.1" };
    });
    const seen = await readCiRun(get, parseCiRunUrl(RUN_URL)!, 42);
    expect(seen).toMatchObject({
      runId: 8841207733, status: "waiting", attempt: 1, branch: "v2.4.1", checkedAt: 42,
      jobs: { total: 5, passed: 1, failed: 1, running: 1, waiting: 1, queued: 1, skipped: 0 },
      failedJobs: [{ name: "macOS tests", failedStep: "Unit tests", url: "https://github.com/example/app/actions/runs/8841207733/job/2" }],
      gates: [{ environment: "windows-signing", environmentId: 4410, reviewers: ["release-team", "octo-maintainer"], waitTimerMinutes: 5 }],
    });
    // The delivered milestone carries what an in-app review re-checks: ids, attempt and commit.
    const condition = ciRunCondition({ url: RUN_URL, on: ["approval_gate"] });
    const evidence = evaluateCiRunCondition(condition, seen, undefined, 42);
    const delivered: ThreadDependency = { id: "watch", backend: "codex", threadId: "release-thread", conditions: [condition],
      mode: "all", onFailure: "notify", continuation: "Review signing", deliver: "operator", status: "delivered",
      outcome: "success", evidence: [evidence], createdAt: 0, updatedAt: 42 };
    expect(ciApprovalsForDependency(delivered)).toEqual([{ url: RUN_URL, runId: 8841207733, repository: "example/app",
      environments: ["windows-signing"], environmentIds: [4410], attempt: 1, ref: "v2.4.1", headSha: "3f9c02e1aa" }]);
    // A milestone saved before ids were read can still be reviewed on GitHub, not here.
    const older = { ...delivered, evidence: [{ ...evidence, ciRun: { ...seen, gates: seen.gates!.map(({ environmentId: _id, ...gate }) => gate) } }] };
    expect(ciApprovalsForDependency(older)[0]).not.toHaveProperty("environmentIds");
    get.mockClear();
    get.mockImplementation(async (_repository, path) => path.includes("/jobs?") ? { jobs: [] } : { id: 8841207733, status: "in_progress" });
    await readCiRun(get, parseCiRunUrl(RUN_URL)!, 43);
    expect(get.mock.calls.map(([, path]) => path)).not.toContainEqual(expect.stringContaining("pending_deployments"));
  });

  it("reads every page of a large matrix, so a failed job past the first hundred counts", async () => {
    const job = (index: number) => ({ id: index, name: `Shard ${index}`, status: "completed", html_url: `${RUN_URL}/job/${index}`,
      conclusion: index === 120 ? "failure" : "success", steps: index === 120 ? [{ name: "Test", conclusion: "failure" }] : [] });
    const all = Array.from({ length: 150 }, (_, index) => job(index + 1));
    const get = vi.fn(async (_repository: unknown, path: string) => {
      if (!path.includes("/jobs?")) return { id: 8841207733, status: "in_progress" };
      const page = Number(new URLSearchParams(path.split("?")[1]).get("page") ?? 1);
      return { total_count: all.length, jobs: all.slice((page - 1) * 100, page * 100) };
    });
    const seen = await readCiRun(get, parseCiRunUrl(RUN_URL)!, 0);
    expect(seen.jobs).toMatchObject({ total: 150, passed: 149, failed: 1 });
    expect(seen.failedJobs).toEqual([{ name: "Shard 120", url: `${RUN_URL}/job/120`, failedStep: "Test" }]);
    expect(get.mock.calls.filter(([, path]) => path.includes("/jobs?"))).toHaveLength(2);
  });

  it("refuses a response for another run", async () => {
    await expect(readCiRun(async () => ({ id: 1, status: "completed" }), parseCiRunUrl(RUN_URL)!, 0)).rejects.toThrow("different run");
    await expect(readCiRun(async () => ({ id: 1, status: "success" }), parseCiRunUrl(PIPELINE_URL)!, 0)).rejects.toThrow("different run");
  });

  it("reads a GitHub Enterprise run from its own host and keeps job links on it", async () => {
    const ref = parseCiRunUrl(GHES_URL, { githubEnterpriseHosts: ["github.example.com"] })!;
    const get = vi.fn(async (_repository: unknown, path: string): Promise<unknown> => path.includes("/jobs?")
      ? { jobs: [
        { id: 1, name: "Build", status: "completed", conclusion: "failure", html_url: "https://github.example.com/example/app/actions/runs/77/job/1" },
        { id: 2, name: "Lint", status: "completed", conclusion: "failure", html_url: "https://github.com/example/app/actions/runs/77/job/2" },
      ] }
      : { id: 77, status: "in_progress" });
    const seen = await readCiRun(get, ref, 0);
    expect(get.mock.calls.every(([repository]) => (repository as { host: string }).host === "github.example.com")).toBe(true);
    expect(get.mock.calls[0]![1]).toBe("repos/example/app/actions/runs/77");
    expect(seen.failedJobs).toEqual([
      { name: "Build", url: "https://github.example.com/example/app/actions/runs/77/job/1" },
      { name: "Lint", url: GHES_URL },
    ]);
  });
});

describe("reading a GitLab pipeline", () => {
  type Job = { id: number; name: string; status: string; allow_failure?: boolean; web_url?: string };
  const ref = parseCiRunUrl(PIPELINE_URL)!;
  const project = "projects/example%2Fplatform%2Fapp";
  const forge = (pipeline: Record<string, unknown>, jobs: Job[], extra: { deployments?: unknown; bridges?: unknown } = {}) =>
    vi.fn(async (_repository: unknown, path: string): Promise<unknown> => {
      if (path.startsWith(`${project}/deployments?`)) {
        if (extra.deployments instanceof Error) throw extra.deployments;
        return extra.deployments ?? [];
      }
      if (path.startsWith(`${project}/pipelines/901/bridges?`)) return extra.bridges ?? [];
      if (path.startsWith(`${project}/pipelines/901/jobs?`)) {
        const page = Number(new URLSearchParams(path.split("?")[1]).get("page") ?? 1);
        return jobs.slice((page - 1) * 100, page * 100);
      }
      if (path === `${project}/pipelines/901`) return { id: 901, name: "Release", ref: "v2.4.1", sha: "3f9c02e1aa", ...pipeline };
      throw new Error(`Unexpected GitLab read: ${path}`);
    });
  const fire = (seen: ThreadDependencyCiRunObservation, ciRun: Omit<NonNullable<ThreadDependencyCondition["ciRun"]>, "url"> = {}) =>
    evaluateCiRunCondition(ciRunCondition({ url: PIPELINE_URL, ...ciRun }), seen, undefined, 0);

  it("maps every pipeline status onto the run vocabulary the readiness rule reads", async () => {
    const expected: Record<string, [string, string | undefined]> = {
      success: ["completed", "success"], failed: ["completed", "failure"], canceled: ["completed", "cancelled"], skipped: ["completed", "skipped"],
      running: ["in_progress", undefined], canceling: ["in_progress", undefined], manual: ["waiting", undefined],
      created: ["queued", undefined], pending: ["queued", undefined], preparing: ["queued", undefined], scheduled: ["queued", undefined],
      waiting_for_resource: ["queued", undefined], waiting_for_callback: ["queued", undefined], brand_new_status: ["brand_new_status", undefined],
    };
    for (const [status, [mapped, conclusion]] of Object.entries(expected)) {
      const seen = await readCiRun(forge({ status }, []), ref, 7);
      expect([status, seen.status, seen.conclusion]).toEqual([status, mapped, conclusion]);
      // A final status always ends a default wait; anything else keeps waiting.
      expect(fire(seen).state).toBe(mapped !== "completed" ? "waiting" : conclusion === "success" || conclusion === "skipped" ? "satisfied" : "failed");
    }
  });

  it("counts jobs, reports failed ones, and lets an allowed failure wake nothing", async () => {
    const get = forge({ status: "running" }, [
      { id: 1, name: "build", status: "success" },
      { id: 2, name: "unit tests\u0007", status: "failed", web_url: "https://gitlab.com/example/platform/app/-/jobs/2" },
      { id: 3, name: "flaky lint", status: "failed", allow_failure: true },
      { id: 4, name: "docs", status: "failed", web_url: "https://elsewhere.example/jobs/4" },
      { id: 5, name: "deploy", status: "created" },
      { id: 6, name: "e2e", status: "running" },
      { id: 7, name: "old", status: "canceled" },
      { id: 8, name: "pages", status: "skipped" },
      { id: 9, name: "locked", status: "waiting_for_resource" },
    ]);
    const seen = await readCiRun(get, ref, 42);
    expect(seen).toMatchObject({
      runId: 901, name: "Release", status: "in_progress", branch: "v2.4.1", headSha: "3f9c02e1aa", checkedAt: 42,
      jobs: { total: 9, passed: 1, failed: 4, running: 1, queued: 2, waiting: 0, skipped: 1 },
      failedJobs: [{ name: "unit tests", url: "https://gitlab.com/example/platform/app/-/jobs/2" }, { name: "docs", url: PIPELINE_URL }],
    });
    expect(seen.gates).toBeUndefined();
    expect(fire(seen, { on: ["job_failed"] })).toMatchObject({ state: "failed", reason: "Job failed: unit tests, docs" });
    const allowed = await readCiRun(forge({ status: "running" }, [{ id: 3, name: "flaky lint", status: "failed", allow_failure: true }]), ref, 0);
    expect(allowed.jobs?.failed).toBe(1);
    expect(fire(allowed, { on: ["job_failed"] }).state).toBe("waiting");
  });

  it("reports a blocked deployment by environment and a playable manual job by name", async () => {
    const deployments = [
      { status: "blocked", environment: { name: "production" }, deployable: { id: 11, pipeline: { id: 901 } },
        approval_summary: { rules: [{ access_level_description: "release-managers", required_approvals: 1 }, { access_level_description: "security" }] } },
      { status: "blocked", environment: { name: "other-pipeline" }, deployable: { id: 99, pipeline: { id: 902 } } },
    ];
    const get = forge({ status: "running" }, [
      { id: 10, name: "build", status: "success" },
      { id: 11, name: "deploy production", status: "manual" },
      { id: 12, name: "publish docs", status: "manual" },
    ], { deployments });
    const seen = await readCiRun(get, ref, 0);
    // The deployment's own job is one gate, not two.
    expect(seen).toMatchObject({ status: "waiting", jobs: { waiting: 2 }, gates: [
      { environment: "production", reviewers: ["release-managers", "security"] },
      { environment: "publish docs", reviewers: [] },
    ] });
    expect(get.mock.calls.map(([, path]) => path)).toContain(`${project}/deployments?status=blocked&order_by=id&sort=desc&per_page=100`);
    expect(fire(seen, { on: ["approval_gate"] })).toMatchObject({ state: "satisfied", reason: "Needs approval: production, publish docs" });
    expect(fire(seen, { on: ["approval_gate"], environments: ["Publish Docs"] })).toMatchObject({ state: "satisfied", reason: "Needs approval: publish docs" });
    expect(fire(seen, { on: ["approval_gate"], environments: ["staging"] }).state).toBe("waiting");
    expect(fire(seen, { on: ["finished"] }).state).toBe("waiting");
  });

  it("keeps the gates of a pipeline that passed with an optional manual job still waiting", async () => {
    const seen = await readCiRun(forge({ status: "success" }, [{ id: 1, name: "build", status: "success" }, { id: 2, name: "deploy production", status: "manual" }]), ref, 0);
    expect(seen).toMatchObject({ status: "completed", conclusion: "success", gates: [{ environment: "deploy production", reviewers: [] }] });
    expect(fire(seen)).toMatchObject({ state: "satisfied", reason: "Run finished: success" });
    expect(fire(seen, { on: ["approval_gate"] })).toMatchObject({ state: "satisfied", reason: "Needs approval: deploy production" });
    expect(fire(seen, { on: ["job_failed"] }).state).toBe("failed");
  });

  it("reads no gates for a failed pipeline, and reads a manual trigger job only when nothing else explains the pause", async () => {
    const failed = forge({ status: "failed" }, [{ id: 2, name: "deploy production", status: "manual" }]);
    expect((await readCiRun(failed, ref, 0)).gates).toBeUndefined();
    expect(failed.mock.calls.some(([, path]) => path.includes("/deployments?"))).toBe(false);

    const bridged = forge({ status: "manual" }, [{ id: 1, name: "build", status: "success" }], { bridges: [{ id: 5, name: "trigger deploy", status: "manual" }, { id: 6, name: "trigger docs", status: "success" }] });
    expect(await readCiRun(bridged, ref, 0)).toMatchObject({ status: "waiting", gates: [{ environment: "trigger deploy", reviewers: [] }] });
    const plain = forge({ status: "running" }, [{ id: 2, name: "deploy", status: "manual" }]);
    await readCiRun(plain, ref, 0);
    expect(plain.mock.calls.some(([, path]) => path.includes("/bridges?"))).toBe(false);
  });

  it("treats deployments the token cannot list as none, and passes other failures on", async () => {
    const jobs = [{ id: 2, name: "deploy", status: "manual" }];
    const forbidden = Object.assign(new Error("GitLab returned HTTP 403."), { code: "forbidden" });
    expect(await readCiRun(forge({ status: "running" }, jobs, { deployments: forbidden }), ref, 0)).toMatchObject({ status: "waiting", gates: [{ environment: "deploy" }] });
    const limited = Object.assign(new Error("GitLab rate limit reached."), { code: "rate_limited" });
    await expect(readCiRun(forge({ status: "running" }, jobs, { deployments: limited }), ref, 0)).rejects.toThrow("rate limit");
  });

  it("refuses a job list that is not a list", async () => {
    const get = vi.fn(async (_repository: unknown, path: string): Promise<unknown> => path.includes("/jobs?") ? { message: "401 Unauthorized" } : { id: 901, status: "running" });
    await expect(readCiRun(get, ref, 0)).rejects.toThrow("invalid job list");
  });

  it("reads every page of jobs", async () => {
    const jobs = Array.from({ length: 150 }, (_, index) => ({ id: index + 1, name: `shard ${index + 1}`, status: index === 119 ? "failed" : "success" }));
    const get = forge({ status: "running" }, jobs);
    const seen = await readCiRun(get, ref, 0);
    expect(seen.jobs).toMatchObject({ total: 150, passed: 149, failed: 1 });
    expect(seen.failedJobs).toEqual([{ name: "shard 120", url: PIPELINE_URL }]);
    expect(get.mock.calls.filter(([, path]) => path.includes("/jobs?"))).toHaveLength(2);
  });
});

describe("CI run poller", () => {
  it("checks at once, every 30 s for ten minutes, then every 2 min, and disarms when nothing waits", async () => {
    let now = 0;
    let urls = [RUN_URL];
    const timers: { fn: () => void; at: number }[] = [];
    const reads: number[] = [];
    const poller = new ThreadDependencyCiRunPoller({
      urls: () => urls,
      read: async () => { reads.push(now); return observation({ checkedAt: now }); },
      observe: async () => undefined,
      now: () => now,
      setTimer: (fn, ms) => { const timer = { fn, at: now + ms }; timers.push(timer); return timer; },
      clearTimer: (handle) => { timers.splice(timers.indexOf(handle as never), 1); },
    });
    const fire = async () => {
      const next = timers.shift()!;
      now = next.at;
      next.fn();
      await vi.waitFor(() => expect(timers.length).toBeGreaterThan(0));
    };
    poller.sync();
    expect(timers).toHaveLength(1);
    for (let index = 0; index < 25; index++) await fire();
    const gaps = reads.slice(1).map((at, index) => at - reads[index]!);
    expect(reads[0]).toBe(0);
    expect(gaps.slice(0, 20).every((gap) => gap === 30_000)).toBe(true);
    expect(gaps.at(-1)).toBe(120_000);
    urls = [];
    poller.sync();
    expect(timers).toHaveLength(0);
    poller.dispose();
  });

  it("reports a failed check as an error observation instead of stopping", async () => {
    let now = 0;
    const observed: ThreadDependencyCiRunObservation[] = [];
    const timers: (() => void)[] = [];
    const poller = new ThreadDependencyCiRunPoller({
      urls: () => [RUN_URL],
      read: async () => { throw Object.assign(new Error("GitHub rate limit reached."), { code: "rate_limited" }); },
      observe: async (_url, seen) => { observed.push(seen); },
      now: () => now,
      setTimer: (fn) => { timers.push(fn); return fn; },
      clearTimer: () => undefined,
    });
    poller.sync();
    timers.shift()!();
    await vi.waitFor(() => expect(observed).toHaveLength(1));
    expect(observed[0]).toMatchObject({ runId: 8841207733, error: "GitHub rate limit reached.", errorCode: "rate_limited" });
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    poller.dispose();
  });
});

describe("Continue After a CI run", () => {
  let db: StateDb;
  let store: ThreadDependencyStore;
  let tempDir: string;
  let now: number;
  let run: ThreadDependencyCiRunObservation;
  const submit = vi.fn(async (_params: { input: { text: string }[] }) => ({ status: "started" as const, turnId: "continuation" }));

  const coordinator = (extra: Partial<ConstructorParameters<typeof ThreadDependencyCoordinator>[0]> = {}) => new ThreadDependencyCoordinator({
    store,
    readThread: async (target) => {
      if (target.threadId !== "release") throw new Error("Thread not found");
      return { turns: [], prs: [] };
    },
    readCiRun: async () => run,
    submit, changed: async () => undefined, now: () => now,
    hasDeliveryReceipt: (item) => store.hasDeliveryReceipt(item),
    ...extra,
  });
  const create = (agent: ThreadDependencyCoordinator, condition = ciRunCondition({ url: `${RUN_URL}/attempts/1`, environments: ["windows-signing"] })) =>
    agent.manage({ action: "create", backend: "codex", threadId: "release", conditions: [condition],
      continuation: "Report the gate. Do not approve. Register a wait for the finish." });

  beforeEach(() => {
    vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "1");
    const temp = createTempStateDb("pwragent-ci-run-dependencies-");
    tempDir = temp.tempDir;
    db = StateDb.open(temp.dbPath);
    store = new ThreadDependencyStore(db.raw);
    now = 100_000;
    run = observation();
    submit.mockClear();
  });
  afterEach(() => { db.close(); removeTempStateDbDir(tempDir); vi.unstubAllEnvs(); });

  it("holds a ready CI wake without repeatedly committing, then admits it on a fresh PR observation", async () => {
    let held = true;
    const agent = coordinator({ stackHold: async () => held ? "Held by #41: needs restack" : undefined });
    await create(agent);
    const milestone = observation({
      status: "waiting", gates: [{ environment: "windows-signing", reviewers: ["release-team"] }],
    });
    await agent.handleCiRunObservation(RUN_URL, milestone);
    expect(store.active()[0]?.status).toBe("ready");
    expect(submit).not.toHaveBeenCalled();
    const { writes } = await measureSqliteWrites(async () => {
      for (let index = 0; index < 10; index++) await agent.handlePrEvent("https://github.com/example/app/pull/41");
    });
    expectSqliteWriteBudget({ scenario: "stack-held-continue-after-ci", writes,
      note: "A ready CI prerequisite waits through repeated lower-stack observations without further commits. 0 MB/day." });
    held = false;
    await agent.handlePrEvent("https://github.com/example/app/pull/41");
    await agent.handlePrEvent("https://github.com/example/app/pull/41");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(store.active()).toEqual([]);
  });

  it("waits through running checks, wakes once at the named gate, and stops asking for checks", async () => {
    const agent = coordinator();
    const response = await create(agent);
    const [registered] = response.dependencies;
    expect(registered).toMatchObject({ status: "waiting", conditions: [{ title: "Release run 8841207733", ciRun: { url: RUN_URL } }] });
    // The list shows the registration check, which is never stored.
    expect(response.dependencies[0]!.evidence[0]!.ciRun).toMatchObject({ status: "in_progress" });
    expect(store.active()[0]!.evidence[0]!.ciRun).toBeUndefined();
    expect(agent.ciRunUrls()).toEqual([RUN_URL]);

    await agent.handleCiRunObservation(RUN_URL, observation({ status: "waiting", gates: [{ environment: "macos-notarize", reviewers: [] }] }));
    expect(submit).not.toHaveBeenCalled();
    await agent.handleCiRunObservation(RUN_URL, observation({ status: "waiting", gates: [{ environment: "windows-signing", reviewers: ["release-team"] }] }));
    expect(submit).toHaveBeenCalledTimes(1);
    const prompt = submit.mock.calls[0]![0].input[0]!.text;
    expect(prompt).toContain("Needs approval: windows-signing");
    expect(prompt).toContain("Approval gate windows-signing: reviewers release-team");
    expect(prompt).toContain(`run: ${RUN_URL}`);
    expect(prompt).toContain("register a new ci_run wait");
    expect(summarizeThreadDependencyPrompt(prompt)).not.toBe(prompt);
    expect(agent.ciRunUrls()).toEqual([]);

    await agent.handleCiRunObservation(RUN_URL, observation({ status: "completed", conclusion: "success" }));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(store.list("codex", "release")[0]).toMatchObject({ status: "delivered", outcome: "success" });
  });

  it("reports a failed job as a failure that holds the plan back", async () => {
    const agent = coordinator();
    await create(agent, ciRunCondition({ url: RUN_URL }));
    await agent.handleCiRunObservation(RUN_URL, observation({ failedJobs: [{ name: "macOS tests", url: RUN_URL, failedStep: "Unit tests" }] }));
    const prompt = submit.mock.calls[0]![0].input[0]!.text;
    expect(prompt).toContain("Job failed: macOS tests");
    expect(prompt).toContain('Failed job: macOS tests, step "Unit tests"');
    expect(prompt).toContain("Report the prerequisite failure.");
  });

  it("fires at registration when the run already sits at the gate", async () => {
    run = observation({ status: "waiting", gates: [{ environment: "windows-signing", reviewers: [] }] });
    await create(coordinator());
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("refuses a run it cannot read, a run off github.com, and an instance without CI reads", async () => {
    await expect(create(coordinator({ readCiRun: async () => { throw new Error("GitHub returned HTTP 404."); } }))).rejects.toThrow("Could not read CI run");
    await expect(create(coordinator(), ciRunCondition({ url: "https://ci.example.com/example/app/actions/runs/1" }))).rejects.toThrow("github.com");
    await expect(create(coordinator({ readCiRun: undefined }))).rejects.toThrow("not available");
    await expect(create(coordinator(), ciRunCondition({ url: GHES_URL }))).rejects.toThrow("github_enterprise_hosts");
    await expect(create(coordinator({ ciRunUrlOptions: () => ({ githubEnterpriseHosts: ["*.example.com", "example.com"] }) }), ciRunCondition({ url: GHES_URL })))
      .rejects.toThrow("github_enterprise_hosts");
    await expect(create(coordinator(), { ...ciRunCondition(), threadId: "release" })).rejects.toThrow("names no thread");
    await expect(create(coordinator(), ciRunCondition({ url: RUN_URL, on: ["finished"], environments: ["windows-signing"] }))).rejects.toThrow("include approval_gate");
    expect(store.active()).toHaveLength(0);
  });

  it("registers a GitLab pipeline, and a GitHub Enterprise run on a host the operator listed", async () => {
    const read = vi.fn(async (_url: string) => run);
    const agent = coordinator({ readCiRun: read, ciRunUrlOptions: () => ({ githubEnterpriseHosts: ["github.example.com"] }) });
    const pipeline = await create(agent, ciRunCondition({ url: `${PIPELINE_URL}/` }));
    expect(pipeline.dependencies[0]).toMatchObject({ status: "waiting", conditions: [{ title: "Release run 901", ciRun: { url: PIPELINE_URL } }] });
    await create(agent, ciRunCondition({ url: `${GHES_URL}/attempts/3` }));
    expect(read.mock.calls.map(([url]) => url)).toEqual([PIPELINE_URL, GHES_URL]);
    expect(agent.ciRunUrls().sort()).toEqual([GHES_URL, PIPELINE_URL].sort());
  });

  it("stores one spelling of a wait, so a reordered retry is the same wait", async () => {
    const agent = coordinator();
    await create(agent, ciRunCondition({ url: RUN_URL, on: ["finished", "approval_gate"], environments: ["windows-signing", "macos-notarize"] }));
    await create(agent, ciRunCondition({ url: `${RUN_URL}/`, on: ["approval_gate", "finished"], environments: ["macos-notarize", "windows-signing"] }));
    expect(store.active()).toHaveLength(1);
    expect(store.active()[0]!.conditions[0]!.ciRun).toEqual({
      url: RUN_URL, on: ["approval_gate", "finished"], environments: ["macos-notarize", "windows-signing"],
    });
  });

  it("announces a changed check at once and an unchanged one every 2 minutes, so the checked time stays current", async () => {
    const changed = vi.fn(async () => undefined);
    const agent = coordinator({ changed });
    await create(agent);
    changed.mockClear();
    await agent.handleCiRunObservation(RUN_URL, observation({ checkedAt: 2 }));
    await agent.handleCiRunObservation(RUN_URL, observation({ checkedAt: 30_002 }));
    expect(changed).toHaveBeenCalledTimes(1);
    await agent.handleCiRunObservation(RUN_URL, observation({ checkedAt: 120_002 }));
    expect(changed).toHaveBeenCalledTimes(2);
    await agent.handleCiRunObservation(RUN_URL, observation({ checkedAt: 150_002, jobs: { total: 5, passed: 3, failed: 0, running: 1, queued: 1, waiting: 0, skipped: 0 } }));
    expect(changed).toHaveBeenCalledTimes(3);
    expect(agent.withCiRunObservations(store.active())[0]!.evidence[0]!.ciRun?.checkedAt).toBe(150_002);
  });

  it("reports a run that is gone after three 404s and stops checking it", async () => {
    const agent = coordinator();
    await create(agent);
    const gone = (checkedAt: number) => ({ runId: 8841207733, status: "unknown", error: "GitHub returned HTTP 404.", errorCode: "not_found", checkedAt });
    await agent.handleCiRunObservation(RUN_URL, gone(2));
    await agent.handleCiRunObservation(RUN_URL, gone(3));
    expect(submit).not.toHaveBeenCalled();
    expect(agent.ciRunUrls()).toEqual([RUN_URL]);
    await agent.handleCiRunObservation(RUN_URL, gone(4));
    expect(submit).toHaveBeenCalledTimes(1);
    const prompt = submit.mock.calls[0]![0].input[0]!.text;
    expect(prompt).toContain("Run can no longer be read: GitHub returned HTTP 404.");
    expect(prompt).toContain("Report the prerequisite failure.");
    expect(agent.ciRunUrls()).toEqual([]);
  });

  it("keeps the latest check in memory only and survives a restart on stored evidence", async () => {
    await create(coordinator());
    const restarted = coordinator();
    await restarted.reconcile();
    expect(store.active()[0]).toMatchObject({ status: "waiting", evidence: [{ state: "waiting", reason: "Waiting for run 8841207733" }] });
    expect(restarted.withCiRunObservations(store.active())[0]!.evidence[0]!.ciRun).toBeUndefined();
    await restarted.handleCiRunObservation(RUN_URL, observation({ status: "completed", conclusion: "failure" }));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(buildDependencyPrompt(store.list("codex", "release")[0]!)).toContain("Run finished: failure");
  });

  it("writes nothing for unchanged checks", async () => {
    const agent = coordinator();
    await create(agent);
    const { writes } = await measureSqliteWrites(async () => {
      for (let check = 0; check < 100; check++) {
        now += 30_000;
        await agent.handleCiRunObservation(RUN_URL, observation({ checkedAt: now, jobs: { total: 5, passed: check % 5, failed: 0, running: 5 - (check % 5), queued: 0, waiting: 0, skipped: 0 } }));
        if (check % 10 === 0) await agent.handleCiRunObservation(RUN_URL, observation({ checkedAt: now, error: "rate limited" }));
      }
    });
    expectSqliteWriteBudget({ scenario: "thread-dependency-ci-run-unchanged-checks", note: "100 checks of a running CI run, with changing job counts and failed checks: zero commits and 0 MB/day while it waits.", writes });
  });

  it("budgets one CI run wait from registration to its continuation", async () => {
    const agent = coordinator();
    const { writes } = await measureSqliteWrites(async () => {
      await create(agent);
      for (let check = 0; check < 20; check++) await agent.handleCiRunObservation(RUN_URL, observation({ checkedAt: check }));
      await agent.handleCiRunObservation(RUN_URL, observation({ status: "waiting", gates: [{ environment: "windows-signing", reviewers: [] }] }));
    });
    expectSqliteWriteBudget({ scenario: "thread-dependency-ci-run-lifecycle", note: "One CI run wait: registration, its first evaluation, the gate firing and the delivered continuation; checks in between write nothing. A release a day is ~0.05 MB/day.", writes });
  });
});
