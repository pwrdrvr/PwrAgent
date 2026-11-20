import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopDecisionModelSettings } from "@pwragent/shared/decision-models";
import type { ThreadUsageLineRecord } from "@pwragent/shared/token-usage-pricing";
import type { OpenAIDecisionQuestion } from "@pwragent/shared/openai-decisions";
import {
  readSystemOneTarget,
  resolveDefaultDecisionProvider,
  type DecisionSettingsReader,
} from "../openai-decisions/decision-provider-targets";
import { OpenAIDecisionsError, OpenAIDecisionsService } from "../openai-decisions/openai-decisions-service";
import {
  buildSystemOneDecisionRequest,
  readSystemOneDecisionAnswers,
} from "../openai-decisions/system-one-decisions";
import { OpenAIDecisionStore } from "../storage/openai-decision-store";
import { StateDb } from "../state/state-db";
import { createTempStateDb, openInMemoryStateDb } from "./sqlite-test-utils";

// Synthetic keys only.
const JEV_KEY = "sk-test-typesafe-jev-0123456789abcdef";
const OPENAI_KEY = "sk-test-openai-decisions-0123456789abcdef";
const CALLER = { backend: "codex", threadId: "thread-a" };

const QUESTIONS: OpenAIDecisionQuestion[] = [
  { type: "predicate", name: "is_bar_joke", instructions: "Is this a bar joke?" },
  {
    type: "choice",
    instructions: "What kind of joke is it?",
    choices: [{ value: "pun", description: "Wordplay" }, { value: "other" }],
  },
  {
    type: "score",
    name: "funny",
    instructions: "How funny is it?",
    levels: [{ label: "groan" }, { label: "chuckle" }, { label: "laugh", description: "Out loud" }],
  },
];

describe("System One mapping", () => {
  it("sends predicate as noul and choice and score as choice criteria, with the prefix and input as state", () => {
    const request = buildSystemOneDecisionRequest({
      questions: QUESTIONS,
      prefix: "Judge jokes told at a bar.",
      input: { joke: "A panda walks into a bar, eats, shoots, and leaves." },
    });
    expect(request.keys).toEqual(["is_bar_joke", "q1", "funny"]);
    expect(JSON.parse(JSON.stringify(request))).toEqual({
      keys: ["is_bar_joke", "q1", "funny"],
      state: "Judge jokes told at a bar.\n\n{\n  \"joke\": \"A panda walks into a bar, eats, shoots, and leaves.\"\n}",
      questions: {
        is_bar_joke: { type: "noul", instructions: "Is this a bar joke?", criteria: { true: "yes", false: "no" } },
        q1: { type: "choice", instructions: "What kind of joke is it?", criteria: { pun: "Wordplay", other: null } },
        funny: {
          type: "choice",
          instructions: "How funny is it?",
          criteria: { groan: null, chuckle: null, laugh: "Out loud" },
        },
      },
    });
    // An unnamed question never takes a name another question already has.
    expect(buildSystemOneDecisionRequest({
      questions: [{ type: "predicate", instructions: "a" }, { type: "predicate", name: "q1", instructions: "b" }],
      input: "x",
    }).keys).toEqual(["q2", "q1"]);
  });

  it("reads answers in stored order, computing a score as the probability-weighted level", () => {
    const answers = readSystemOneDecisionAnswers({
      model: "jev-latest",
      answers: {
        is_bar_joke: { type: "noul", noul: 0.91 },
        q1: { type: "choice", choice: "pun", probabilities: { pun: 0.8, other: 0.2 } },
        funny: { type: "choice", choice: "laugh", probabilities: { groan: 0.2, chuckle: 0.3, laugh: 0.5 } },
      },
    }, QUESTIONS, ["is_bar_joke", "q1", "funny"]);
    expect(answers[0]).toEqual({ type: "predicate", name: "is_bar_joke", probability: 0.91 });
    expect(answers[1]).toEqual({ type: "choice", choice: "pun", probabilities: { pun: 0.8, other: 0.2 }, confidence: 0.8 });
    expect(answers[2]).toMatchObject({ type: "score", name: "funny", confidence: 0.5 });
    expect((answers[2] as { score: number }).score).toBeCloseTo(1.3, 10);
    // A missing answer is reported for that question only.
    expect(readSystemOneDecisionAnswers({ answers: {} }, QUESTIONS.slice(0, 1), ["is_bar_joke"])[0])
      .toMatchObject({ type: "unavailable", name: "is_bar_joke" });
  });
});

type Captured = { url?: string; headers: IncomingHttpHeaders; body: unknown };

describe("registered decisions on Jev", () => {
  let server: Server;
  let endpoint: string;
  let requests: Captured[];
  let responses: Array<{ status: number; body: unknown }>;
  let db: StateDb;
  let usage: ThreadUsageLineRecord[];
  let logs: string[];

  beforeEach(async () => {
    requests = [];
    responses = [];
    usage = [];
    logs = [];
    db = openInMemoryStateDb();
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({ url: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        const next = responses.shift() ?? {
          status: 200,
          body: { model: "jev-latest", answers: { is_bar_joke: { type: "noul", noul: 0.88 } } },
        };
        response.writeHead(next.status, { "content-type": "application/json" });
        response.end(JSON.stringify(next.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  function makeService(options: { jevKey?: string } = { jevKey: JEV_KEY }) {
    const readApiKey = vi.fn(async () => OPENAI_KEY);
    const service = new OpenAIDecisionsService({
      store: new OpenAIDecisionStore(db),
      readApiKey,
      readSystemOneTarget: async (provider) => provider === "jev" && options.jevKey
        ? { endpoint, model: "jev-latest", apiKey: options.jevKey }
        : undefined,
      readAccountSettings: () => ({}),
      profileId: () => "test-profile",
      recordUsageLines: async (lines) => { usage.push(...lines); },
      endpoint: `${endpoint}/v1/decisions`,
      newDecisionId: () => "decision-1",
      log: {
        info: (message, fields) => logs.push(`${message} ${JSON.stringify(fields)}`),
        warn: (message, fields) => logs.push(`${message} ${JSON.stringify(fields)}`),
      },
    });
    return { service, readApiKey };
  }

  const definition = {
    name: "bar_joke",
    provider: "jev",
    instructions: "Is this a bar joke?",
    question: { type: "predicate", name: "is_bar_joke" },
    inputSchema: { type: "string", maxLength: 500 },
  };

  it("posts the System One body to Jev with the Jev key and returns normalized answers", async () => {
    const { service, readApiKey } = makeService();
    expect(await service.register(CALLER, definition)).toMatchObject({ provider: "jev", version: 1 });
    const result = await service.invoke(CALLER, {
      name: "bar_joke",
      input: "A panda walks into a bar, eats, shoots, and leaves.",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("/v1/systemone");
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${JEV_KEY}`);
    expect(requests[0]!.body).toEqual({
      model: "jev-latest",
      state: "A panda walks into a bar, eats, shoots, and leaves.",
      questions: {
        is_bar_joke: { type: "noul", instructions: "Is this a bar joke?", criteria: { true: "yes", false: "no" } },
      },
    });
    expect(result).toMatchObject({
      provider: "jev",
      model: "jev-latest",
      answers: [{ type: "predicate", name: "is_bar_joke", probability: 0.88 }],
      usage: { priceStatus: "unavailable" },
    });
    // The OpenAI key is never read for a Jev decision, and no spend line is written.
    expect(readApiKey).not.toHaveBeenCalled();
    await service.flushUsage();
    expect(usage).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(JEV_KEY);
    expect(logs.join("\n")).not.toContain(JEV_KEY);
  });

  it("refuses to run without a Jev key and sends nothing", async () => {
    const { service } = makeService({});
    await service.register(CALLER, definition);
    await expect(service.invoke(CALLER, { name: "bar_joke", input: "x" })).rejects.toMatchObject({ code: "credential_missing" });
    expect(requests).toHaveLength(0);
  });

  it("maps Jev refusals without leaking the key", async () => {
    const { service } = makeService();
    await service.register(CALLER, definition);
    responses.push({ status: 401, body: { detail: "bad key" } });
    await expect(service.invoke(CALLER, { name: "bar_joke", input: "x" })).rejects.toMatchObject({ code: "credential_rejected" });
    responses.push({ status: 422, body: { detail: `model not served for ${JEV_KEY}` } });
    const error = await service.invoke(CALLER, { name: "bar_joke", input: "x" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenAIDecisionsError);
    expect((error as OpenAIDecisionsError).code).toBe("upstream_error");
    expect((error as OpenAIDecisionsError).message).toContain("model not served");
    expect((error as OpenAIDecisionsError).message).not.toContain(JEV_KEY);
  });

  it("can move a decision between providers by update", async () => {
    const { service } = makeService();
    await service.register(CALLER, definition);
    expect(service.update(CALLER, { ...definition, provider: "openai" })).toMatchObject({ provider: "openai", version: 2 });
    expect(service.update(CALLER, { ...definition, provider: undefined })).toMatchObject({ provider: "openai", version: 3 });
  });
});

describe("default provider and targets", () => {
  function reader(params: {
    openaiKey?: string;
    jevKey?: string;
    localKey?: string;
    decision?: DesktopDecisionModelSettings;
  }): DecisionSettingsReader {
    return {
      resolveOpenAIDecisionsApiKey: async () => params.openaiKey,
      resolveDecisionModelSettings: () => params.decision ?? {},
      resolveDecisionApiKey: async (provider) => provider === "jev" ? params.jevKey : params.localKey,
      hasOpenAIDecisionsApiKey: async () => Boolean(params.openaiKey),
      hasDecisionApiKey: async (provider) => Boolean(provider === "jev" ? params.jevKey : params.localKey),
      resolveOpenAIDecisionsSettings: () => ({}),
    };
  }

  it("uses what the operator set up when a registration names no provider", async () => {
    // Jev key saved, no model name, Decisions left Off: the case from 2026-11-14.
    expect(await resolveDefaultDecisionProvider(reader({ jevKey: JEV_KEY }))).toBe("jev");
    expect(await resolveDefaultDecisionProvider(reader({ jevKey: JEV_KEY, openaiKey: OPENAI_KEY }))).toBe("openai");
    expect(await resolveDefaultDecisionProvider(reader({ decision: { model: "local" } }))).toBe("local");
    expect(await resolveDefaultDecisionProvider(reader({}))).toBe("openai");
  });

  it("picks a default from key presence without decrypting any key", async () => {
    const decrypting: DecisionSettingsReader = {
      ...reader({ jevKey: JEV_KEY }),
      resolveOpenAIDecisionsApiKey: async () => { throw new Error("decrypted the OpenAI key"); },
      resolveDecisionApiKey: async () => { throw new Error("decrypted a decision key"); },
    };
    expect(await resolveDefaultDecisionProvider(decrypting)).toBe("jev");
  });

  it("defaults the Jev model to jev-latest and needs a Jev key", async () => {
    expect(await readSystemOneTarget(reader({ jevKey: JEV_KEY }), "jev"))
      .toEqual({ endpoint: "https://api.typesafe.ai", model: "jev-latest", apiKey: JEV_KEY });
    expect(await readSystemOneTarget(reader({}), "jev")).toBeUndefined();
    expect(await readSystemOneTarget(reader({ decision: { local: { endpoint: "http://127.0.0.1:9000" } } }), "local"))
      .toEqual({ endpoint: "http://127.0.0.1:9000", model: "clef-flash" });
  });
});

it("reads decisions saved before the provider column existed as OpenAI decisions", () => {
  const fixture = createTempStateDb("openai-decisions-provider-column-");
  try {
    const first = StateDb.open(fixture.dbPath);
    first.raw.exec("ALTER TABLE openai_decision_versions DROP COLUMN provider");
    first.raw.prepare(
      `INSERT INTO openai_decision_versions (decision_id, version, name, scope, owner_backend, owner_thread_id,
        status, questions_json, prefix_text, input_schema_json, prompt_cache_key, created_at)
       VALUES ('old', 1, 'old_rule', 'profile', 'codex', NULL, 'active', '[]', NULL, '{"type":"string"}', 'k', 1)`,
    ).run();
    first.close();
    const reopened = StateDb.open(fixture.dbPath);
    try {
      const store = new OpenAIDecisionStore(reopened);
      expect(store.getActive("old")).toMatchObject({ provider: "openai" });
      // The reopened profile can store a decision for another provider.
      store.insertFirstVersion({
        ...store.getActive("old")!, decisionId: "new", name: "new_rule", provider: "jev",
      });
      expect(store.getActive("new")).toMatchObject({ provider: "jev" });
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});
