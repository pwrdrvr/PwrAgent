import fc from "fast-check";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DECISION_INPUT_FILE_MAX_BYTES,
  DecisionFileError,
  parseDecisionInputsFileContent,
  readDecisionInputsFile,
  resolveWritableDecisionOutputFile,
  type DecisionFileAccess,
} from "../openai-decisions/decision-io-files";
import { OpenAIDecisionsError, OpenAIDecisionsService } from "../openai-decisions/openai-decisions-service";
import { OpenAIDecisionStore } from "../storage/openai-decision-store";
import type { StateDb } from "../state/state-db";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const OPENAI_KEY = "sk-test-openai-file-io-0123456789abcdef";
const JEV_KEY = "sk-test-jev-file-io-0123456789abcdef";
const JEV_TARGET = { endpoint: "https://jev.test", model: "jev-latest", apiKey: JEV_KEY };
const CALLER = { backend: "acp:antigravity", threadId: "thread-file-io" };
const PREDICATE = { instructions: "Is it concrete?", question: { type: "predicate", name: "concrete" } };

type Wake = { caller: { backend: string; threadId: string }; batchId: string; text: string };

let db: StateDb;
let tempRoot: string;
let workspaceDir: string;
let outsideDir: string;
let privateRoot: string;
let resultsDir: string;
let wakes: Wake[];

beforeEach(async () => {
  db = openInMemoryStateDb();
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "pwragent-decision-io-"));
  workspaceDir = path.join(tempRoot, "workspace");
  outsideDir = path.join(tempRoot, "outside");
  privateRoot = path.join(tempRoot, "pwragent-home");
  resultsDir = path.join(tempRoot, "batch-results");
  await Promise.all([
    mkdir(workspaceDir, { recursive: true }),
    mkdir(outsideDir, { recursive: true }),
    mkdir(path.join(privateRoot, "profiles", "default", "state", "agent-memory"), { recursive: true }),
    mkdir(path.join(privateRoot, "worktrees", "wt-1", "repo"), { recursive: true }),
    mkdir(resultsDir, { recursive: true }),
  ]);
  wakes = [];
});

afterEach(async () => {
  db.close();
  await rm(tempRoot, { recursive: true, force: true });
});

function defaultAccess(): DecisionFileAccess {
  return {
    allowedRoots: [workspaceDir, path.join(privateRoot, "worktrees", "wt-1", "repo")],
    privateStorageRoots: [privateRoot],
  };
}

function makeService(
  fetch: typeof globalThis.fetch,
  options: { access?: DecisionFileAccess; includeResultsDir?: boolean } = {},
) {
  let nextBatch = 0;
  return new OpenAIDecisionsService({
    store: new OpenAIDecisionStore(db),
    readApiKey: async () => OPENAI_KEY,
    readSystemOneTarget: async (provider) => provider === "jev" ? JEV_TARGET : undefined,
    readAccountSettings: () => ({}),
    profileId: () => "test-profile",
    recordUsageLines: async () => undefined,
    wakeThread: async (caller, wake) => { wakes.push({ caller, ...wake }); },
    newBatchId: () => `io-${(nextBatch += 1)}`,
    ...(options.includeResultsDir === false ? {} : { batchResultsDirectory: () => resultsDir }),
    resolveCallerFileAccess: async () => options.access ?? defaultAccess(),
    fetch,
    endpoint: "https://openai.test/v1/decisions",
  });
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

async function errorOf(work: () => Promise<unknown>): Promise<OpenAIDecisionsError> {
  const error = await work().then(() => undefined, (caught: unknown) => caught);
  if (!(error instanceof OpenAIDecisionsError)) {
    throw new Error(`expected OpenAIDecisionsError, got ${String(error)}`);
  }
  return error;
}

describe("parseDecisionInputsFileContent property", () => {
  // Rule: any non-empty array of JSON values round-trips identically through
  // both `.json` (compact or pretty) and `.jsonl`/`.ndjson` (with optional BOM
  // and blank lines), including single-item arrays in JSONL.
  it("round-trips arbitrary input arrays identically across JSON and JSONL", () => {
    const itemArb = fc.oneof(
      fc.string({ maxLength: 80 }),
      fc.dictionary(fc.stringMatching(/^[a-z]{1,8}$/), fc.oneof(fc.string({ maxLength: 40 }), fc.integer(), fc.boolean()), { maxKeys: 5 }),
      fc.array(fc.record({ type: fc.constant("input_text"), text: fc.string({ maxLength: 30 }) }), { minLength: 1, maxLength: 2 }),
    );
    fc.assert(
      fc.property(
        fc.array(itemArb, { minLength: 1, maxLength: 20 }),
        fc.boolean(),
        fc.boolean(),
        (items, withBom, pretty) => {
          const bom = withBom ? "\uFEFF" : "";
          const jsonText = `${bom}${JSON.stringify(items, null, pretty ? 2 : 0)}\n`;
          expect(parseDecisionInputsFileContent(jsonText, "/tmp/batch.json")).toEqual(items);

          const jsonlText = `${bom}\n${items.map((item) => JSON.stringify(item)).join("\r\n\n")}\n`;
          expect(parseDecisionInputsFileContent(jsonlText, "/tmp/batch.jsonl")).toEqual(items);
          expect(parseDecisionInputsFileContent(jsonlText, "/tmp/batch.ndjson")).toEqual(items);
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe("local file access boundaries", () => {
  // Rule: inputsFile and outputFile always refuse destinations outside
  // allowedRoots, inside private storage, or escaping via traversal/symlinks,
  // while permitting nested workspace and worktree paths.
  it("enforces allowedRoots, privateStorageRoots, traversal, and symlink boundaries", async () => {
    const access = defaultAccess();
    const safeSegment = fc.stringMatching(/^[a-z0-9_-]{1,12}$/);
    await fc.assert(
      fc.asyncProperty(safeSegment, safeSegment, async (dirName, fileName) => {
        const nestedOut = path.join(workspaceDir, dirName, `${fileName}.jsonl`);
        const resolved = await resolveWritableDecisionOutputFile(nestedOut, access);
        expect(resolved.endsWith(path.join(dirName, `${fileName}.jsonl`))).toBe(true);

        const traversal = path.join(workspaceDir, dirName, "..", "..", "outside", `${fileName}.jsonl`);
        const traversalError = await resolveWritableDecisionOutputFile(traversal, access)
          .then(() => undefined, (err: unknown) => err);
        expect(traversalError).toBeInstanceOf(DecisionFileError);
        expect((traversalError as DecisionFileError).code).toBe("file_access_denied");

        const privateStateTarget = path.join(privateRoot, "profiles", "default", "state", `${fileName}.jsonl`);
        const privateError = await resolveWritableDecisionOutputFile(privateStateTarget, access)
          .then(() => undefined, (err: unknown) => err);
        expect(privateError).toBeInstanceOf(DecisionFileError);
        expect((privateError as DecisionFileError).code).toBe("file_access_denied");
      }),
      { numRuns: 20 },
    );

    // Worktrees under ~/.pwragent/worktrees/... remain allowed when listed in allowedRoots.
    const worktreeFile = path.join(privateRoot, "worktrees", "wt-1", "repo", "inputs.json");
    await writeFile(worktreeFile, JSON.stringify(["ok"]), "utf8");
    expect(await readDecisionInputsFile(worktreeFile, access)).toEqual(["ok"]);

    // Symlink inside workspace pointing outside allowedRoots must be rejected for both read and write.
    const outsideSecret = path.join(outsideDir, "secret.json");
    await writeFile(outsideSecret, JSON.stringify(["leaked"]), "utf8");
    const linkFile = path.join(workspaceDir, "escape.json");
    await symlink(outsideSecret, linkFile);
    const readLinkErr = await readDecisionInputsFile(linkFile, access).then(() => undefined, (err: unknown) => err);
    expect((readLinkErr as DecisionFileError).code).toBe("file_access_denied");
    const writeLinkErr = await resolveWritableDecisionOutputFile(linkFile, access)
      .then(() => undefined, (err: unknown) => err);
    expect((writeLinkErr as DecisionFileError).code).toBe("invalid_input");

    // Symlinked parent directory escaping workspace must also be rejected for outputFile.
    const linkDir = path.join(workspaceDir, "escape-dir");
    await symlink(outsideDir, linkDir);
    const writeViaLinkDir = await resolveWritableDecisionOutputFile(path.join(linkDir, "sub", "out.jsonl"), access)
      .then(() => undefined, (err: unknown) => err);
    expect((writeViaLinkDir as DecisionFileError).code).toBe("file_access_denied");
  });
});

describe("decisions_invoke file I/O", () => {
  // Rule: a batch invoked with inputsFile + outputFile writes every item
  // 0..count-1 in input order matching the provider oracle, respects detail,
  // never leaks rail fields or credentials, and omits inline results from the
  // MCP response unless inlineResults is explicitly true.
  it("matches the oracle across .json and .jsonl inputsFile/outputFile and inlineResults modes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 18 }),
        fc.integer({ min: 1, max: 8 }),
        fc.constantFrom(".json", ".jsonl"),
        fc.constantFrom(".json", ".jsonl"),
        fc.constantFrom("compact" as const, "full" as const),
        fc.constantFrom(undefined, false, true),
        async (count, concurrency, inExt, outExt, detail, inlineResults) => {
          const items = Array.from({ length: count }, (_, index) => ({ id: index, text: `item-${index}` }));
          const inPath = path.join(workspaceDir, `in-${count}-${concurrency}${inExt}`);
          const outPath = path.join(workspaceDir, "nested", `out-${count}-${concurrency}${outExt}`);
          const serializedIn = inExt === ".json"
            ? JSON.stringify(items)
            : `${items.map((item) => JSON.stringify(item)).join("\n")}\n`;
          await writeFile(inPath, serializedIn, "utf8");

          const service = makeService(async (_url, init) => {
            const body = JSON.parse(String(init!.body)) as { state: string };
            const parsed = JSON.parse(body.state) as { id: number };
            return jsonResponse({
              model: "jev-latest",
              answers: { concrete: { noul: parsed.id / 100 } },
            });
          });

          const response = await service.invoke(CALLER, {
            definition: { provider: "jev", ...PREDICATE },
            inputsFile: inPath,
            outputFile: outPath,
            concurrency,
            detail,
            ...(inlineResults !== undefined ? { inlineResults } : {}),
          }) as Record<string, unknown>;

          expect(response.succeeded).toBe(count);
          expect(response.outputFile).toBeTruthy();
          expect(response.outputFileError).toBeUndefined();

          // Default when outputFile is set is inlineResults: false.
          if (inlineResults === true) {
            expect(Array.isArray(response.results)).toBe(true);
            expect((response.results as unknown[]).length).toBe(count);
          } else {
            expect("results" in response).toBe(false);
          }

          const rawOut = await readFile(String(response.outputFile), "utf8");
          expect(rawOut).not.toContain(JEV_KEY);
          expect(rawOut).not.toContain("inputPreview");
          expect(rawOut).not.toContain("inputImages");

          const writtenItems = outExt === ".json"
            ? (JSON.parse(rawOut) as { detail: string; count: number; results: Array<{ index: number; ok: boolean; model?: string; answers: Array<{ probability: number }> }> }).results
            : rawOut.trim().split("\n").map((line) => JSON.parse(line) as { index: number; ok: boolean; model?: string; answers: Array<{ probability: number }> });

          expect(writtenItems.map((item) => item.index)).toEqual(items.map((item) => item.id));
          writtenItems.forEach((item, index) => {
            expect(item.ok).toBe(true);
            expect(item.answers[0]!.probability).toBe(index / 100);
            if (detail === "full") {
              expect(item.model).toBe("jev-latest");
            } else {
              expect("model" in item).toBe(false);
            }
          });
        },
      ),
      { numRuns: 20 },
    );
  });

  it("writes outputFile and reports it in wake-up text for background batches", async () => {
    const inPath = path.join(workspaceDir, "bg-inputs.jsonl");
    const outPath = path.join(workspaceDir, "bg-out.json");
    await writeFile(inPath, `${["a", "b", "c"].map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");

    const service = makeService(async () => jsonResponse({
      model: "gpt-6-luna",
      answers: [{ type: "predicate", name: "concrete", probability: 0.85 }],
      usage: { input_tokens: 100, output_tokens: 0 },
    }, 200, { "x-request-id": "req_bg" }));

    const started = await service.invoke(CALLER, {
      definition: { provider: "openai", ...PREDICATE },
      inputsFile: inPath,
      outputFile: outPath,
      background: true,
    }) as { batchId: string; outputFile: string; next: string };

    expect(started.outputFile).toBeTruthy();
    expect(started.next).toContain("outputFile");
    expect("results" in started).toBe(false);

    // Wait for the background batch wake-up.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.text).toContain(started.outputFile);

    const written = JSON.parse(await readFile(started.outputFile, "utf8")) as {
      batchId: string;
      succeeded: number;
      detail: string;
      results: Array<{ index: number; ok: boolean }>;
    };
    expect(written).toMatchObject({ batchId: started.batchId, succeeded: 3, detail: "compact" });
    expect(written.results.map((item) => item.index)).toEqual([0, 1, 2]);
  });

  it("supports inlineResults: false without outputFile on a batch and keeps resultsFile readable", async () => {
    const service = makeService(async () => jsonResponse({
      model: "jev-latest",
      answers: { concrete: { noul: 0.6 } },
    }));
    const result = await service.invoke(CALLER, {
      definition: { provider: "jev", ...PREDICATE },
      inputs: ["one", "two"],
      inlineResults: false,
    }) as Record<string, unknown>;

    expect(result.succeeded).toBe(2);
    expect(result.resultsFile).toBeTruthy();
    expect("results" in result).toBe(false);
    const paged = await service.batchResults(CALLER, { batchId: result.batchId }) as { results: unknown[] };
    expect(paged.results).toHaveLength(2);
  });

  it("supports outputFile on a single input and omits bulky body unless inlineResults is true", async () => {
    const outPath = path.join(workspaceDir, "single.json");
    const service = makeService(async () => jsonResponse({
      model: "gpt-6-luna",
      answers: [{ type: "predicate", name: "concrete", probability: 0.91 }],
      usage: { input_tokens: 50, output_tokens: 0 },
    }, 200, { "x-request-id": "req_single" }));

    const silent = await service.invoke(CALLER, {
      definition: { provider: "openai", ...PREDICATE },
      input: "check this diff",
      outputFile: outPath,
    }) as Record<string, unknown>;
    expect(silent.outputFile).toBeTruthy();
    expect("response" in silent).toBe(false);
    expect("answers" in silent).toBe(false);

    const onDisk = JSON.parse(await readFile(String(silent.outputFile), "utf8")) as {
      requestId: string;
      response: { answers: Array<{ probability: number }> };
    };
    expect(onDisk.requestId).toBe("req_single");
    expect(onDisk.response.answers[0]!.probability).toBe(0.91);

    const withInline = await service.invoke(CALLER, {
      definition: { provider: "openai", ...PREDICATE },
      input: "check this diff",
      outputFile: outPath,
      inlineResults: true,
    }) as Record<string, unknown>;
    expect(withInline.outputFile).toBeTruthy();
    expect(withInline.response).toBeTruthy();

    // inlineResults: false without outputFile is rejected for a single input.
    expect((await errorOf(() => service.invoke(CALLER, {
      definition: { provider: "openai", ...PREDICATE },
      input: "check this diff",
      inlineResults: false,
    }))).code).toBe("invalid_input");
  });

  it("rejects invalid file combinations, bad JSONL lines, missing files, and oversized files before calling the provider", async () => {
    let calls = 0;
    const service = makeService(async () => {
      calls += 1;
      return jsonResponse({ answers: { concrete: { noul: 0.5 } } });
    });
    const validFile = path.join(workspaceDir, "valid.json");
    await writeFile(validFile, JSON.stringify(["a"]), "utf8");

    expect((await errorOf(() => service.invoke(CALLER, {
      definition: { provider: "jev", ...PREDICATE },
      input: "a",
      inputsFile: validFile,
    }))).code).toBe("invalid_input");

    expect((await errorOf(() => service.invoke(CALLER, {
      definition: { provider: "jev", ...PREDICATE },
      inputs: ["a"],
      inputsFile: validFile,
    }))).code).toBe("invalid_input");

    expect((await errorOf(() => service.invoke(CALLER, {
      definition: { provider: "jev", ...PREDICATE },
      inputsFile: path.join(workspaceDir, "missing.json"),
    }))).code).toBe("file_not_found");

    const badJsonl = path.join(workspaceDir, "bad.jsonl");
    await writeFile(badJsonl, "{\"a\":1}\nnot-json\n", "utf8");
    const badLineErr = await errorOf(() => service.invoke(CALLER, {
      definition: { provider: "jev", ...PREDICATE },
      inputsFile: badJsonl,
    }));
    expect(badLineErr.code).toBe("invalid_input");
    expect(badLineErr.message).toContain("line 2");

    const hugeFile = path.join(workspaceDir, "huge.json");
    await writeFile(hugeFile, " ".repeat(DECISION_INPUT_FILE_MAX_BYTES + 1), "utf8");
    expect((await errorOf(() => service.invoke(CALLER, {
      definition: { provider: "jev", ...PREDICATE },
      inputsFile: hugeFile,
    }))).code).toBe("invalid_input");

    expect((await errorOf(() => service.invoke(CALLER, {
      definition: { provider: "jev", ...PREDICATE },
      inputsFile: validFile,
      outputFile: path.join(outsideDir, "nope.json"),
    }))).code).toBe("file_access_denied");

    expect(calls).toBe(0);
  });
});
