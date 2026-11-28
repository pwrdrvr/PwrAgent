import fc from "fast-check";
import { expect, it } from "vitest";
import report from "./model-request-report.cjs";
import { legacyMcpResult, mainSha, mcpResult, result, runUrl, source } from "./fixtures/model-request-report.fixture.mjs";

it("accepts only bounded numeric measurements and keeps untrusted text out of the report", () => {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 800 }),
    fc.constantFrom("ceilings", "observed"),
    fc.constantFrom(0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, "| @owner <script>", ["9"]),
    (value, location, invalid) => {
      const input = result(value, 100);
      expect(report.validateResult(input)).toBe(input);
      const values = input.results[0][location];
      values.firstInstructionBytes = invalid;
      expect(report.validateResult(input)).toBeUndefined();
    },
  ));
  const badProvider = result(100, 110);
  badProvider.results[0].provider = { toString: "codex" };
  expect(report.validateResult(badProvider)).toBeUndefined();
  badProvider.results[0].provider = "claude";
  expect(report.validateResult(badProvider)).toBeUndefined();
});

it("compares each provider with its own baseline regardless of artifact order", () => {
  fc.assert(fc.property(
    fc.tuple(...Array.from({ length: 6 }, () => fc.integer({ min: 1, max: 600 }))),
    fc.boolean(), fc.boolean(),
    ([codex, claude, antigravity, codexBase, claudeBase, antigravityBase], currentReversed, baseReversed) => {
      const current = result(codex, claude, antigravity);
      const baseline = result(codexBase, claudeBase, antigravityBase);
      if (currentReversed) current.results.reverse();
      if (baseReversed) baseline.results.reverse();
      const comment = report.renderComment({
        current, baseline, source, baselineRun: { id: 10, sha: mainSha }, exactBase: true, runUrl,
      });
      for (const [provider, before, after, limit] of [
        ["Codex", codexBase, codex, 300],
        ["Claude", claudeBase, claude, 340],
        ["Antigravity", antigravityBase, antigravity, 380],
      ]) {
        const row = comment.split("\n").find((line) => line.startsWith(`| ${provider} | First turn total body bytes |`));
        const [, , , base, measured, impact, ceiling, status] = row.split("|").map((column) => column.trim());
        expect({ base, measured, ceiling, status }).toEqual({
          base: `${before} B`, measured: `${after} B`, ceiling: `${limit} B`, status: after <= limit ? "✅" : "❌",
        });
        expect(impact.split(" (")[0]).toBe(after === before
          ? "0"
          : `${after > before ? "+" : "−"}${Math.abs(after - before)} B`);
      }
      expect(comment).toContain(codex > 300 || claude > 340 || antigravity > 380 ? "exceeded one or more ceilings" : "stayed within their ceilings");
    },
  ), { examples: [[[300, 340, 380, 299, 341, 378], false, true], [[300, 340, 381, 299, 341, 380], true, false]] });
});

it("shows missing baselines, fallback baselines and changes to the ceilings", () => {
  const current = result(100, 200);
  expect(report.renderComment({ current, source, runUrl })).toContain("baseline is unavailable");
  const baseline = result(100, 200);
  baseline.results[0].ceilings.firstCalls = 2;
  const comment = report.renderComment({
    current, source, runUrl, baseline, baselineRun: { id: 10, sha: mainSha }, exactBase: false,
  });
  expect(comment).toContain("latest available successful");
  expect(comment).toContain("First turn model calls from 2 to 1");
  expect(comment).toContain(runUrl(10));
});

it("requires every provider and rejects a primary body larger than its whole turn", () => {
  const current = result(105, 200, 330);
  expect(report.validateResult(current)).toBe(current);
  expect(report.validateResult({ ...current, results: current.results.slice(0, 2) })).toBeUndefined();
  expect(report.validateResult({ ...current, version: 1 })).toBeUndefined();
  expect(report.validateResult({ ...current, baseSha: "main" })).toBeUndefined();
  current.results[2].observed.firstPrimaryBytes += 1;
  expect(report.validateResult(current)).toBeUndefined();
});

it("selects artifacts only from the completed attempt across full and partial reruns", () => {
  fc.assert(fc.property(
    fc.array(fc.constantFrom("partial-rerun", "full-without-upload", "full-with-upload"), { minLength: 1, maxLength: 8 }),
    (reruns) => {
      const artifacts = [];
      const completed = new Map();
      for (const [index, kind] of ["full-with-upload", ...reruns].entries()) {
        const attempt = index + 1;
        if (kind === "full-with-upload") {
          const id = attempt * 100;
          artifacts.unshift({ id, name: `model-request-results-attempt-${attempt}`, size_in_bytes: 500 });
          completed.set(attempt, id);
        }
        // GitHub retains prior uploads under the same run ID. Even a
        // redelivered event can describe only what that attempt uploaded.
        for (let delivered = attempt; delivered > 0; delivered--) {
          expect(report.findAttemptArtifact(artifacts, delivered)?.id).toBe(completed.get(delivered));
        }
      }
    },
  ), { examples: [[["partial-rerun", "full-without-upload", "full-with-upload"]]] });
});

it("matches MCP catalog deltas to the same provider, turn and metric in historical uploads", () => {
  fc.assert(fc.property(
    fc.tuple(...Array.from({ length: 5 }, () => fc.integer({ min: 1, max: 400 }))),
    fc.boolean(),
    ([base, current, baselineTools, currentTools, followUp], reversed) => {
      const currentMcp = mcpResult(401, current, 402);
      const baselineMcp = legacyMcpResult(403, base, 404);
      for (const [artifact, bytes, tools] of [[currentMcp, current, currentTools], [baselineMcp, base, baselineTools]]) {
        const claude = artifact.results.find(({ provider }) => provider === "claude");
        Object.assign(claude.first, { bytes: bytes + 400, primaryBytes: bytes + 400, toolBytes: 400 });
        Object.assign(claude.next, { bytes: followUp + 400, primaryBytes: followUp + 400, toolBytes: tools });
      }
      if (reversed) baselineMcp.results.reverse();
      expect(report.validateMcpResult(currentMcp)).toBe(currentMcp);
      expect(report.validateMcpResult(baselineMcp)).toBe(baselineMcp);
      const comment = report.renderComment({
        current: result(110, 120), currentMcp, baseline: result(119, 130), baselineMcp,
        source, baselineRun: { id: 10, sha: mainSha }, exactBase: true, runUrl,
      }).split("### 240 configured MCP tools")[1];
      expect(comment).toContain(`| Claude | First turn total body bytes | ${base + 400} B | ${current + 400} B |`);
      expect(comment).toContain(`| Claude | Follow-up total body bytes | ${followUp + 400} B | ${followUp + 400} B | 0 |`);
      const row = comment.split("\n").find((line) => line.startsWith("| Claude | Follow-up tool definitions |"));
      expect(row).toContain(`| ${baselineTools} B | ${currentTools} B |`);
      expect(row.includes("**+")).toBe(currentTools > baselineTools);
      expect(row.endsWith(currentTools > 40 ? "❌ |" : "✅ |")).toBe(true);
    },
  ), { examples: [[[101, 114, 39, 60, 111], true]] });
});

it("validates legacy and extended MCP artifacts without admitting data from untrusted text fields", () => {
  fc.assert(fc.property(
    fc.constantFrom("bytes", "primaryBytes", "toolBytes", "continuationBytes", "calls", "roundTripCalls"),
    fc.constantFrom(null, "| @owner", ["9"], {}, 1.5, Number.MAX_SAFE_INTEGER + 1, -1),
    (key, value) => {
      const legacy = legacyMcpResult(100, 200, 220);
      const extended = mcpResult(100, 200, 220);
      expect(report.validateMcpResult(legacy)).toBe(legacy);
      expect(report.validateMcpResult(extended)).toBe(extended);
      extended.toolUse[0].observed[key] = value;
      expect(report.validateMcpResult(extended)).toBeUndefined();
    },
  ));
  const extended = mcpResult(100, 200, 220);
  extended.results[0].provider = { toString: "codex" };
  expect(report.validateMcpResult(extended)).toBeUndefined();
  extended.results[0].provider = "codex";
  extended.results[1].provider = "codex";
  expect(report.validateMcpResult(extended)).toBeUndefined();
});
